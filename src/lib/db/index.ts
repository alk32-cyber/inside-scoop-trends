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

/**
 * Serverless hosts (Vercel) have no persistent writable disk. Without DATABASE_URL the app
 * runs on an in-memory database there: the demo snapshot in demo mode, otherwise empty.
 */
export function isEphemeralDb(env: Record<string, string | undefined> = process.env): boolean {
  return !env.DATABASE_URL && Boolean(env.VERCEL);
}

/** Exports demo rows (is_demo or belonging to demo topics/items) as gzipped JSON. */
export async function exportDemoSnapshot(db: Db): Promise<Buffer> {
  const { gzipSync } = await import("node:zlib");
  const filters: Record<string, string> = {
    topics: "is_demo",
    topic_aliases: "topic_id IN (SELECT id FROM topics WHERE is_demo)",
    source_items: "is_demo",
    item_metric_snapshots: "item_id IN (SELECT id FROM source_items WHERE is_demo)",
    topic_source_links: "topic_id IN (SELECT id FROM topics WHERE is_demo)",
  };
  const out: Record<string, unknown[]> = {};
  for (const t of SNAPSHOT_TABLES) {
    const [row] = await db.query<{ rows: unknown[] | null }>(`SELECT json_agg(x) AS rows FROM "${t}" x WHERE ${filters[t] ?? "is_demo"}`);
    out[t] = row?.rows ?? [];
  }
  return gzipSync(JSON.stringify(out));
}

/** Loads a demo snapshot with one bulk insert per table, then fixes sequences. */
export async function importDemoSnapshot(db: Db, gz: Buffer): Promise<void> {
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

/** Opens a database from the environment: DATABASE_URL (Postgres) or an embedded PGlite directory. */
export async function openDb(opts: { inMemory?: boolean } = {}): Promise<Db> {
  if (opts.inMemory) return createPgliteDb();
  const url = process.env.DATABASE_URL;
  if (url) return createPgDb(url);
  if (isEphemeralDb()) {
    const db = await createPgliteDb();
    const demo = process.env.DEMO_MODE === "true" || process.env.DEMO_MODE === "1";
    if (demo && fs.existsSync(DEMO_SNAPSHOT_PATH)) {
      await migrate(db);
      await importDemoSnapshot(db, fs.readFileSync(DEMO_SNAPSHOT_PATH));
      await reanchorDemo(db);
    }
    return db;
  }
  return createPgliteDb(process.env.PGLITE_DATA_DIR ?? path.join(process.cwd(), ".data", "pglite"));
}

const globalForDb = globalThis as unknown as { __trendDb?: Promise<Db> };

/** Process-wide singleton used by API routes and scripts. Migrations run on first open. */
export function getDb(): Promise<Db> {
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
