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

/** Opens a database from the environment: DATABASE_URL (Postgres) or an embedded PGlite directory. */
export async function openDb(opts: { inMemory?: boolean } = {}): Promise<Db> {
  if (opts.inMemory) return createPgliteDb();
  const url = process.env.DATABASE_URL;
  if (url) return createPgDb(url);
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
