import fs from "node:fs";
import path from "node:path";

/**
 * Minimal database interface shared by the Postgres (production) and PGlite
 * (local development / tests) backends. Both speak the same SQL dialect, so
 * one set of migrations and queries serves both.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function createPgDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  // Return BIGINT/NUMERIC as JS numbers; counts here stay far below 2^53.
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DATABASE_POOL_MAX ?? 5) });

  const wrap = (client: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return fn(wrap(client));
    },
    async close() {},
  });

  return {
    ...wrap(pool),
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const parsers = { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) };
  const pg = dataDir ? new PGlite(dataDir, { parsers }) : new PGlite({ parsers });
  await pg.waitReady;

  type Queryable = { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (s: string) => Promise<unknown> };
  const wrap = (q: Queryable): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      return (await q.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return fn(wrap(q));
    },
    async close() {},
  });

  return {
    ...wrap(pg),
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return pg.transaction(async (tx) => fn(wrap(tx as unknown as Queryable)));
    },
    async close() {
      await pg.close();
    },
  };
}

/** Bundled demo data (built by `npm run demo:snapshot`), used when no persistent database exists. */
export const DEMO_SNAPSHOT_PATH = path.join(process.cwd(), "demo", "demo-snapshot.json.gz");

/** Tables in foreign-key order. */
const SNAPSHOT_TABLES = [
  "topics",
  "topic_aliases",
  "source_items",
  "item_metric_snapshots",
  "topic_source_links",
  "observations",
  "trend_scores",
  "trend_score_history",
  "content_recommendations",
  "ingestion_runs",
];

export type StorageMode = "postgres" | "blob" | "ephemeral" | "local";

/**
 * Where data lives:
 *  - postgres:  DATABASE_URL is set (recommended for production)
 *  - blob:      on Vercel without Postgres but with a Blob store (BLOB_READ_WRITE_TOKEN): an
 *               in-memory database loaded from, and saved back to, a private Blob snapshot
 *  - ephemeral: on Vercel with neither: in-memory only (demo snapshot in demo mode)
 *  - local:     embedded PGlite files in ./.data (development)
 */
export function storageMode(env: Record<string, string | undefined> = process.env): StorageMode {
  if (env.DATABASE_URL) return "postgres";
  if (env.VERCEL && env.BLOB_READ_WRITE_TOKEN) return "blob";
  if (env.VERCEL) return "ephemeral";
  return "local";
}

/** True when nothing written would survive the serverless instance. */
export function isEphemeralDb(env: Record<string, string | undefined> = process.env): boolean {
  return storageMode(env) === "ephemeral";
}

function isDemoEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE === "true" || env.DEMO_MODE === "1";
}

/** Exports the demo (isDemo=true) or live (false) rows of every table as gzipped JSON. */
export async function exportSnapshot(db: Db, isDemo: boolean): Promise<Buffer> {
  const { gzipSync } = await import("node:zlib");
  const flag = isDemo ? "TRUE" : "FALSE";
  const filters: Record<string, string> = {
    topic_aliases: `topic_id IN (SELECT id FROM topics WHERE is_demo = ${flag})`,
    item_metric_snapshots: `item_id IN (SELECT id FROM source_items WHERE is_demo = ${flag})`,
    topic_source_links: `topic_id IN (SELECT id FROM topics WHERE is_demo = ${flag})`,
  };
  const out: Record<string, unknown[]> = {};
  for (const t of SNAPSHOT_TABLES) {
    const [row] = await db.query<{ rows: unknown[] | null }>(`SELECT json_agg(x) AS rows FROM "${t}" x WHERE ${filters[t] ?? `is_demo = ${flag}`}`);
    out[t] = row?.rows ?? [];
  }
  return gzipSync(JSON.stringify(out));
}

export function exportDemoSnapshot(db: Db): Promise<Buffer> {
  return exportSnapshot(db, true);
}

/** Loads a snapshot with one bulk insert per table, then fixes sequences. */
export async function importSnapshot(db: Db, gz: Buffer): Promise<void> {
  const { gunzipSync } = await import("node:zlib");
  const data = JSON.parse(gunzipSync(gz).toString("utf8")) as Record<string, unknown[]>;
  for (const t of SNAPSHOT_TABLES) {
    const rows = data[t] ?? [];
    if (rows.length === 0) continue;
    await db.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json) ON CONFLICT DO NOTHING`, [JSON.stringify(rows)]);
  }
  const seqs = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_default LIKE 'nextval%'`,
  );
  for (const s of seqs) {
    await db.query(`SELECT setval(pg_get_serial_sequence('"${s.table_name}"', '${s.column_name}'), COALESCE((SELECT MAX("${s.column_name}") FROM "${s.table_name}"), 0) + 1, false)`);
  }
}

/** Opens a database from the environment (see storageMode). */
export async function openDb(opts: { inMemory?: boolean } = {}): Promise<Db> {
  if (opts.inMemory) return createPgliteDb();
  const mode = storageMode();
  if (mode === "postgres") return createPgDb(process.env.DATABASE_URL!);
  if (mode === "local") return createPgliteDb(process.env.PGLITE_DATA_DIR ?? path.join(process.cwd(), ".data", "pglite"));

  const db = await createPgliteDb();
  await migrate(db);
  if (isDemoEnv()) {
    if (fs.existsSync(DEMO_SNAPSHOT_PATH)) {
      await importSnapshot(db, fs.readFileSync(DEMO_SNAPSHOT_PATH));
      await reanchorDemo(db);
    }
  } else if (mode === "blob") {
    const { loadLiveBlob } = await import("./blobStore");
    const snap = await loadLiveBlob();
    if (snap) await importSnapshot(db, snap.buf);
    globalForDb.__blobEtag = snap?.etag ?? null;
  }
  globalForDb.__loadedAt = Date.now();
  return db;
}

const globalForDb = globalThis as unknown as { __trendDb?: Promise<Db>; __blobEtag?: string | null; __loadedAt?: number; __checking?: boolean };

/** How often a Blob-backed instance checks for a newer snapshot written by the scheduled job. */
const BLOB_REFRESH_MS = 120_000;

/**
 * Process-wide database used by API routes and scripts. Migrations run on first open.
 * In Blob mode, a newer snapshot (different ETag) replaces the in-memory copy; pass
 * `fresh: true` to force a reload (the ingestion job does this before writing).
 */
export async function getDb(opts: { fresh?: boolean } = {}): Promise<Db> {
  if (storageMode() === "blob" && !isDemoEnv() && globalForDb.__trendDb) {
    const stale = opts.fresh || Date.now() - (globalForDb.__loadedAt ?? 0) > BLOB_REFRESH_MS;
    if (stale && !globalForDb.__checking) {
      globalForDb.__checking = true;
      try {
        const { headLiveEtag } = await import("./blobStore");
        const etag = opts.fresh ? null : await headLiveEtag();
        if (opts.fresh || etag !== globalForDb.__blobEtag) {
          const old = globalForDb.__trendDb;
          globalForDb.__trendDb = undefined;
          // Let in-flight queries on the old copy finish before closing it.
          setTimeout(() => old.then((d) => d.close()).catch(() => {}), 30_000);
        } else {
          globalForDb.__loadedAt = Date.now();
        }
      } catch (err) {
        console.error("[db] blob freshness check failed:", (err as Error).message);
      } finally {
        globalForDb.__checking = false;
      }
    }
  }
  if (!globalForDb.__trendDb) {
    globalForDb.__trendDb = (async () => {
      const db = await openDb();
      await migrate(db);
      return db;
    })().catch((err) => {
      globalForDb.__trendDb = undefined;
      throw err;
    });
  }
  return globalForDb.__trendDb;
}

/**
 * Blob mode only: prunes old rows and saves the live database back to Blob. The write is
 * conditional on the ETag that was loaded, so a concurrent writer is never overwritten.
 */
export async function persistLive(db: Db, now = new Date()): Promise<{ bytes: number } | null> {
  if (storageMode() !== "blob") return null;
  const day = 86400_000;
  await db.query("DELETE FROM source_items WHERE is_demo = FALSE AND COALESCE(published_at, first_collected_at) < $1", [new Date(now.getTime() - 10 * day)]);
  await db.query("DELETE FROM observations WHERE is_demo = FALSE AND observed_at < $1", [new Date(now.getTime() - 14 * day)]);
  await db.query("DELETE FROM trend_score_history WHERE is_demo = FALSE AND as_of < $1", [new Date(now.getTime() - 30 * day)]);
  await db.query("DELETE FROM ingestion_runs WHERE is_demo = FALSE AND started_at < $1", [new Date(now.getTime() - 30 * day)]);
  const buf = await exportSnapshot(db, false);
  const { saveLiveBlob } = await import("./blobStore");
  globalForDb.__blobEtag = await saveLiveBlob(buf, globalForDb.__blobEtag ?? null);
  globalForDb.__loadedAt = Date.now();
  return { bytes: buf.length };
}

export function migrationsDir(): string {
  return path.join(process.cwd(), "db", "migrations");
}

/** Applies pending migrations in filename order. Safe to run repeatedly. */
export async function migrate(db: Db, dir = migrationsDir()): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}

/**
 * Shifts every timestamp of the (simulated) demo snapshot forward so its timeline ends now.
 * Without this, a snapshot built days ago would show every topic as stale. Only ever applied
 * to the in-memory demo copy; the dashboard banner states that the timeline is simulated.
 */
export async function reanchorDemo(db: Db, now = new Date()): Promise<void> {
  const [row] = await db.query<{ latest: Date | null }>("SELECT MAX(computed_at) AS latest FROM trend_scores WHERE is_demo");
  if (!row?.latest) return;
  const shiftSeconds = Math.floor((now.getTime() - new Date(row.latest).getTime()) / 1000);
  if (shiftSeconds <= 0) return;
  const cols = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp with time zone' AND table_name <> 'schema_migrations'`,
  );
  const byTable = new Map<string, string[]>();
  for (const c of cols) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
  for (const [table, columns] of byTable) {
    const sets = columns.map((c) => `"${c}" = "${c}" + make_interval(secs => ${shiftSeconds})`).join(", ");
    await db.exec(`UPDATE "${table}" SET ${sets}`);
  }
}
