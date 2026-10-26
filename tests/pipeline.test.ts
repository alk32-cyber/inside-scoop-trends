import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { exportSnapshot, importSnapshot, migrate, openDb, type Db } from "@/lib/db";
import { deriveObservations } from "@/lib/pipeline/derive";
import { ingestProvider, storeItems } from "@/lib/pipeline/ingest";
import { normalizeRecent } from "@/lib/pipeline/normalize";
import { scoreAll } from "@/lib/pipeline/score";
import { listTrends, systemStatus, TrendsQuery } from "@/lib/api/service";
import { youtubeAdapter } from "@/lib/providers/youtube";
import type { RawItem } from "@/lib/providers/types";

const NOW = new Date(Date.UTC(2026, 9, 20, 12));
const H = 3600_000;
let db: Db;

beforeAll(async () => {
  db = await openDb({ inMemory: true });
  await migrate(db, path.join(process.cwd(), "db", "migrations"));
});
afterAll(async () => db.close());

function video(id: string, title: string, publishedHoursAgo: number, views: number): RawItem {
  return { externalId: id, url: `https://www.youtube.com/watch?v=${id}`, contentType: "video", title, publishedAt: new Date(NOW.getTime() - publishedHoursAgo * H), views, likes: Math.round(views / 25), comments: Math.round(views / 200) };
}

describe("storage and derivation", () => {
  it("stores items idempotently and derives view deltas between snapshots", async () => {
    const t1 = new Date(NOW.getTime() - 6 * H);
    const items = [video("v1", "Micro SaaS ideas for students", 8, 1000), video("v2", "Building a micro-SaaS in public", 7, 400)];
    await storeItems(db, "youtube", items, t1);
    await storeItems(db, "youtube", items, t1); // same run twice: no duplicates
    await storeItems(db, "youtube", [video("v1", "Micro SaaS ideas for students", 8, 5000), video("v2", "Building a micro-SaaS in public", 7, 1400)], NOW);
    const [{ n }] = await db.query<{ n: number }>("SELECT COUNT(*)::int8 AS n FROM source_items");
    expect(n).toBe(2);
    const [{ s }] = await db.query<{ s: number }>("SELECT COUNT(*)::int8 AS s FROM item_metric_snapshots");
    expect(s).toBe(4);

    await normalizeRecent(db, { now: NOW });
    await deriveObservations(db, ["micro-saas"], new Date(NOW.getTime() - 48 * H), NOW);
    const first = await db.query<{ new_views: number }>("SELECT new_views FROM observations WHERE topic_id = 'micro-saas' AND source = 'youtube' ORDER BY observed_at");
    await deriveObservations(db, ["micro-saas"], new Date(NOW.getTime() - 48 * H), NOW); // idempotent rebuild
    const second = await db.query<{ new_views: number }>("SELECT new_views FROM observations WHERE topic_id = 'micro-saas' AND source = 'youtube' ORDER BY observed_at");
    expect(second).toEqual(first);
    // Published within 24h of first snapshot: 1000 + 400 attributed at t1, then deltas 4000 + 1000 at NOW.
    const total = second.reduce((a, r) => a + Number(r.new_views ?? 0), 0);
    expect(total).toBe(6400);
  });

  it("counts a syndicated story once across buckets", async () => {
    const base = "https://news.example/startup-layoffs";
    const copies: RawItem[] = [0, 1, 2].map((i) => ({
      externalId: `${base}#${i}`,
      url: `${base}?utm_source=outlet${i}`,
      contentType: "article",
      title: "Startup layoffs hit three more fintech companies",
      publishedAt: new Date(NOW.getTime() - (10 - i * 3) * H),
    }));
    await storeItems(db, "news", copies, NOW);
    const keys = await db.query<{ story_key: string }>("SELECT DISTINCT story_key FROM source_items WHERE provider = 'news'");
    expect(keys).toHaveLength(1);
    await db.query("INSERT INTO topics (id, canonical_key, name, status) VALUES ('layoffs', 'startup layoff', 'Startup layoffs', 'active') ON CONFLICT DO NOTHING");
    await db.query("INSERT INTO topic_source_links (topic_id, source_item_id, match_method) SELECT 'layoffs', id, 'test' FROM source_items WHERE provider = 'news'");
    await deriveObservations(db, ["layoffs"], new Date(NOW.getTime() - 48 * H), NOW);
    const rows = await db.query<{ new_posts: number; unique_stories: number }>("SELECT new_posts, unique_stories FROM observations WHERE topic_id = 'layoffs'");
    expect(rows.reduce((a, r) => a + r.new_posts, 0)).toBe(3);
    expect(rows.reduce((a, r) => a + r.unique_stories, 0)).toBe(1);
  });
});

describe("provider availability", () => {
  it("records a skipped run without credentials and never reports the provider as connected", async () => {
    const run = await ingestProvider(db, youtubeAdapter, {}, NOW);
    expect(run.status).toBe("skipped");
    expect(run.error).toContain("YOUTUBE_API_KEY");
    const status = await systemStatus({ db, demo: false, env: {} });
    const yt = status.providers.find((p) => p.provider === "youtube")!;
    expect(yt.connection).toBe("not_configured");
    expect(yt.missingEnv).toEqual(["YOUTUBE_API_KEY"]);
    // Items stored directly above exist, but without a recorded successful run nothing claims a connection.
    const withKey = await systemStatus({ db, demo: false, env: { YOUTUBE_API_KEY: "k" } });
    expect(withKey.providers.find((p) => p.provider === "youtube")!.connection).toBe("configured_untested");
  });

  it("records a failed run when the provider errors, and keeps going", async () => {
    const failing = { ...youtubeAdapter, collect: async () => Promise.reject(new Error("HTTP 500 for https://x/?key=abc")) };
    const run = await ingestProvider(db, failing, { YOUTUBE_API_KEY: "abc" }, NOW);
    expect(run.status).toBe("failed");
    expect(run.error).not.toContain("abc");
    const status = await systemStatus({ db, demo: false, env: { YOUTUBE_API_KEY: "abc" } });
    expect(status.providers.find((p) => p.provider === "youtube")!.connection).toBe("failing");
  });

  it("scores and serves topics, keeping demo and live data apart", async () => {
    const res = await scoreAll(db, { asOf: NOW, isDemo: false });
    expect(res.scored).toBeGreaterThan(0);
    const live = await listTrends(TrendsQuery.parse({}), { db, demo: false });
    expect(live.mode).toBe("live");
    expect(live.items.every((i) => !i.isDemo)).toBe(true);
    const demo = await listTrends(TrendsQuery.parse({}), { db, demo: true });
    expect(demo.items).toHaveLength(0);
    expect(() => TrendsQuery.parse({ limit: "1000" })).toThrow();
    expect(() => TrendsQuery.parse({ lifecycle: "viral" })).toThrow();
  });
});

describe("live snapshot (Blob storage mode)", () => {
  it("round-trips the live database exactly and keeps sequences usable", async () => {
    const counts = async (d: Db) =>
      d.query<{ t: string; n: number }>(
        `SELECT 'items' AS t, COUNT(*)::int8 AS n FROM source_items UNION ALL SELECT 'obs', COUNT(*)::int8 FROM observations
         UNION ALL SELECT 'scores', COUNT(*)::int8 FROM trend_scores UNION ALL SELECT 'runs', COUNT(*)::int8 FROM ingestion_runs
         UNION ALL SELECT 'snaps', COUNT(*)::int8 FROM item_metric_snapshots ORDER BY 1`,
      );
    const gz = await exportSnapshot(db, false);
    const copy = await openDb({ inMemory: true });
    await migrate(copy, path.join(process.cwd(), "db", "migrations"));
    await importSnapshot(copy, gz);
    expect(await counts(copy)).toEqual(await counts(db));
    // New rows get fresh ids after restore (sequences were advanced).
    await storeItems(copy, "youtube", [video("v9", "Another micro SaaS story", 1, 10)], NOW);
    const [{ n }] = await copy.query<{ n: number }>("SELECT COUNT(DISTINCT id)::int8 AS n FROM source_items");
    const [{ m }] = await copy.query<{ m: number }>("SELECT COUNT(*)::int8 AS m FROM source_items");
    expect(n).toBe(m);
    await copy.close();
  });
});
