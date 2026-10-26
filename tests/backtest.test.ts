import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { migrate, openDb, type Db } from "@/lib/db";
import { runBacktest } from "@/lib/backtest";
import { defaultScoringConfig } from "@/lib/config";

const END = Date.UTC(2026, 9, 20, 0);
const H = 3600_000;
let db: Db;

/** Saved history for 8 topics with known trajectories: steady growth, steady decline, or flat. */
beforeAll(async () => {
  db = await openDb({ inMemory: true });
  await migrate(db, path.join(process.cwd(), "db", "migrations"));
  const rates = [0.5, 0.35, 0.2, 0, 0, -0.2, -0.35, -0.5]; // per day, log scale
  for (let i = 0; i < rates.length; i++) {
    await db.query("INSERT INTO topics (id, canonical_key, name, category, status, first_seen_at) VALUES ($1, $1, $1, 'startups', 'active', $2)", [`t${i}`, new Date(END - 12 * 24 * H)]);
    for (let h = 12 * 24; h >= 1; h--) {
      const at = new Date(END - h * H);
      const days = (12 * 24 - h) / 24;
      const posts = Math.max(0, Math.round(2 * Math.exp(rates[i] * days) + ((i + h) % 3) - 1));
      await db.query(
        "INSERT INTO observations (topic_id, source, observed_at, collected_at, new_posts, unique_stories, sample_size) VALUES ($1, 'news', $2, $2, $3, $3, $3)",
        [`t${i}`, at, posts],
      );
    }
  }
  for (let h = 12 * 24; h >= 1; h -= 2) {
    await db.query("INSERT INTO ingestion_runs (provider, job, started_at, finished_at, status) VALUES ('news', 'ingest', $1, $1, 'success')", [new Date(END - h * H)]);
  }
});
afterAll(async () => db.close());

describe("backtest", () => {
  it("measures whether high-ranked topics subsequently gained attention", async () => {
    const report = await runBacktest(db, defaultScoringConfig, { stepHours: 24, minTopics: 5 });
    expect(report.defaultMetrics.cutoffs).toBeGreaterThanOrEqual(7);
    // Growing topics rank high and keep growing; declining topics rank low and keep declining.
    expect(report.defaultMetrics.spearman!).toBeGreaterThan(0.5);
    expect(report.defaultMetrics.precisionAtK!).toBeGreaterThanOrEqual(report.defaultMetrics.baselinePrecisionAtK!);
    expect(report.tuning).not.toBeNull();
    const w = report.tuning!.bestWeights;
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});
