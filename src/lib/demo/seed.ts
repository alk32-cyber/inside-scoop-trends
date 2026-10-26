import type { Db } from "../db";
import { loadScoringConfig } from "../config";
import type { RawItem } from "../providers/types";
import { analyzeTop } from "../pipeline/analyze";
import { deriveObservations } from "../pipeline/derive";
import { finishRun, startRun, storeInterest, storeItems } from "../pipeline/ingest";
import { curatedTopicId, normalizeRecent } from "../pipeline/normalize";
import { matchCurated } from "../normalize/grouping";
import { canonicalKey } from "../normalize/text";
import { scoreAll } from "../pipeline/score";

/**
 * DEMO DATA GENERATOR. Everything produced here is simulated:
 *  - is_demo = TRUE on every row, sources are named demo_*, URLs point at example.com/demo
 *  - topic names are generic business themes, not claims about real events
 * It runs through the real pipeline (storage, normalization, derivation, scoring) so the
 * dashboard and the algorithm can be exercised before any provider credentials exist.
 */

type Shape = number[]; // relative activity per day, oldest -> newest (7 days)

interface DemoTopic {
  phrase: string;
  shapes: Partial<Record<"news" | "youtube" | "reddit" | "trends", Shape>>;
  /** Items per day at shape value 1. */
  scale?: number;
  /** All news coverage is copies of one story, and Reddit posts link to it. */
  singleStory?: boolean;
}

const RISE: Shape = [0.3, 0.3, 0.35, 0.4, 0.7, 1.4, 3];
const STEADY: Shape = [1, 1, 1.05, 0.95, 1, 1.05, 1];
const PEAK: Shape = [0.3, 0.6, 1.3, 2.4, 3, 2.9, 2.4];
const COOL: Shape = [2.5, 2.4, 2.1, 1.7, 1.2, 0.8, 0.5];
const EMERGE: Shape = [0, 0, 0, 0, 0.1, 0.6, 1.6];
const FADED: Shape = [1.5, 1.2, 0.8, 0.3, 0.05, 0, 0];

const TOPICS: DemoTopic[] = [
  { phrase: "AI agents", shapes: { news: RISE, youtube: RISE, reddit: RISE, trends: RISE }, scale: 4 },
  { phrase: "side hustles", shapes: { news: STEADY, youtube: STEADY, reddit: STEADY, trends: STEADY }, scale: 6 },
  { phrase: "TikTok Shop", shapes: { news: PEAK, youtube: PEAK, reddit: PEAK, trends: PEAK }, scale: 3 },
  { phrase: "four-day work week", shapes: { news: COOL, reddit: COOL, trends: COOL }, scale: 3 },
  { phrase: "micro-SaaS", shapes: { youtube: EMERGE, reddit: EMERGE }, scale: 3 },
  { phrase: "salary negotiation", shapes: { reddit: [0.6, 0.6, 0.7, 0.7, 0.9, 1.2, 1.7] }, scale: 4 },
  { phrase: "creator-led brands", shapes: { news: [0.5, 0.5, 0.6, 0.6, 0.8, 1, 1.5], youtube: [0.5, 0.6, 0.6, 0.7, 0.9, 1.2, 1.6] }, scale: 3 },
  { phrase: "founder burnout", shapes: { news: STEADY, reddit: STEADY }, scale: 2 },
  { phrase: "pop-up shops", shapes: { news: FADED, youtube: FADED }, scale: 3 },
  { phrase: "vending machine business", shapes: { youtube: [0.2, 0.2, 0.2, 0.2, 0.3, 0.5, 3.5] }, scale: 1 },
  { phrase: "startup layoffs", shapes: { news: [0.2, 0.2, 0.2, 0.2, 0.3, 0.5, 4], reddit: [0.2, 0.2, 0.2, 0.3, 0.3, 0.6, 3] }, scale: 2, singleStory: true },
];

const TEMPLATES = [
  "{T}: what it means for you",
  "Is {T} really worth it",
  "The truth about {T}",
  "{T} explained",
  "Why everyone is talking about {T}",
  "How {T} actually works",
  "I tried {T} for 30 days",
  "{T} mistakes to avoid",
  "The future of {T}",
  "Inside the {T} hype",
];

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

const HOUR = 3600_000;
const SNAPSHOT_EVERY_H = 3;

interface DemoItem {
  provider: "demo_youtube" | "demo_reddit" | "demo_news";
  item: RawItem;
  /** Final engagement the item converges to; counters follow a saturating curve. */
  total: number;
}

function buildItems(now: number, rand: () => number): DemoItem[] {
  const out: DemoItem[] = [];
  let seq = 0;
  for (const t of TOPICS) {
    const slug = t.phrase.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    for (const src of ["news", "youtube", "reddit"] as const) {
      const shape = t.shapes[src];
      if (!shape) continue;
      const provider = `demo_${src}` as DemoItem["provider"];
      for (let day = 0; day < 7; day++) {
        const expected = shape[day] * (t.scale ?? 2);
        const n = Math.floor(expected) + (rand() < expected - Math.floor(expected) ? 1 : 0);
        for (let k = 0; k < n; k++) {
          seq++;
          const published = now - (7 - day) * 24 * HOUR + rand() * 24 * HOUR;
          if (published > now - HOUR) continue;
          const tpl = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
          let title = tpl.replace("{T}", t.phrase);
          title = title.charAt(0).toUpperCase() + title.slice(1);
          const id = `${slug}-${src}-${seq}`;
          const momentum = shape[day];
          if (src === "news") {
            const url = t.singleStory ? `https://example.com/demo/news/${slug}-story` : `https://example.com/demo/news/${id}`;
            // Syndicated copies: same headline and article, reached through tracking-tagged links.
            const outlet = ["Demo Wire", "Sample Times", "Example Daily", "Placeholder Post"][seq % 4];
            out.push({
              provider,
              total: 0,
              item: {
                externalId: t.singleStory ? `${url}#copy-${seq}` : url,
                url: t.singleStory ? `${url}?utm_source=${outlet.toLowerCase().replace(/ /g, "_")}` : url,
                contentType: "article",
                title: t.singleStory ? `${t.phrase.charAt(0).toUpperCase() + t.phrase.slice(1)} hit three more companies - ${outlet}` : title,
                snippet: "Simulated article for demo mode.",
                author: outlet,
                publishedAt: new Date(published),
              },
            });
          } else if (src === "youtube") {
            out.push({
              provider,
              total: Math.round(4000 + 30000 * momentum * (0.4 + rand())),
              item: { externalId: id, url: `https://example.com/demo/video/${id}`, contentType: "video", title, snippet: "Simulated video for demo mode.", author: "Demo Channel", publishedAt: new Date(published) },
            });
          } else {
            // For the single-story topic most threads are link posts to the same article.
            const linkPost = Boolean(t.singleStory) && rand() < 0.7;
            out.push({
              provider,
              total: Math.round(20 + 150 * momentum * (0.4 + rand())),
              item: {
                externalId: id,
                url: `https://example.com/demo/thread/${id}`,
                linkedUrl: linkPost ? `https://example.com/demo/news/${slug}-story` : null,
                contentType: "post",
                title: linkPost ? `Discussion: ${t.phrase} hit three more companies` : title,
                snippet: "Simulated discussion thread for demo mode.",
                author: "r/demo",
                publishedAt: new Date(published),
              },
            });
          }
        }
      }
    }
  }
  return out;
}

function countersAt(d: DemoItem, at: number, rand: () => number): Pick<RawItem, "views" | "likes" | "comments"> {
  const age = (at - d.item.publishedAt!.getTime()) / HOUR;
  const f = 1 - Math.exp(-Math.max(0, age) / 20);
  if (d.provider === "demo_youtube") {
    const views = Math.round(d.total * f);
    return { views, likes: Math.round(views * (0.035 + rand() * 0.01)), comments: Math.round(views * (0.004 + rand() * 0.002)) };
  }
  if (d.provider === "demo_reddit") return { views: null, likes: Math.round(d.total * 3 * f), comments: Math.round(d.total * f) };
  return { views: null, likes: null, comments: null };
}

export async function clearDemo(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("DELETE FROM content_recommendations WHERE is_demo");
    await tx.query("DELETE FROM trend_score_history WHERE is_demo");
    await tx.query("DELETE FROM trend_scores WHERE is_demo");
    await tx.query("DELETE FROM observations WHERE is_demo");
    await tx.query("DELETE FROM source_items WHERE is_demo"); // cascades to snapshots and links
    await tx.query("DELETE FROM topic_aliases WHERE topic_id IN (SELECT id FROM topics WHERE is_demo)");
    await tx.query("DELETE FROM topics WHERE is_demo");
    await tx.query("DELETE FROM ingestion_runs WHERE is_demo");
  });
}

/** Seeds 7 days of simulated history ending at `now`, then scores it at several points so trajectories exist. */
export async function seedDemo(db: Db, opts: { now?: Date; seed?: number } = {}): Promise<{ items: number; topics: number }> {
  const now = (opts.now ?? new Date()).getTime();
  const rand = rng(opts.seed ?? 7);
  await clearDemo(db);
  const items = buildItems(now, rand);
  const cfg = loadScoringConfig();

  // Replay collection runs every SNAPSHOT_EVERY_H hours, exactly as live ingestion would.
  const start = now - 7 * 24 * HOUR;
  const firstRun = Math.ceil(start / (SNAPSHOT_EVERY_H * HOUR)) * SNAPSHOT_EVERY_H * HOUR;
  for (let at = firstRun; at <= now; at += SNAPSHOT_EVERY_H * HOUR) {
    for (const provider of ["demo_youtube", "demo_reddit", "demo_news"] as const) {
      const visible = items.filter((d) => d.provider === provider && d.item.publishedAt!.getTime() <= at && (provider !== "demo_news" || d.item.publishedAt!.getTime() > at - 48 * HOUR));
      const runId = await startRun(db, provider, "ingest", true, new Date(at));
      const raw = visible.map((d) => ({ ...d.item, ...countersAt(d, at, rand) }));
      const stored = await storeItems(db, provider, raw, new Date(at), true);
      await finishRun(db, runId, { status: "success", itemsFetched: raw.length, itemsNew: stored.newCount, requestsMade: 0, newestItemAt: stored.newestPublished, details: { simulated: true } }, new Date(at + 60_000));
    }
  }

  const normalized = await normalizeRecent(db, { now: new Date(now), isDemo: true });

  // Simulated normalized search interest (0-100 relative index), hourly.
  const topics = await db.query<{ id: string; name: string }>("SELECT id, name FROM topics WHERE is_demo AND status = 'active'");
  const runId = await startRun(db, "demo_google_trends", "ingest", true, new Date(now));
  let points = 0;
  for (const def of TOPICS) {
    const shape = def.shapes.trends;
    if (!shape) continue;
    const curated = matchCurated(def.phrase)[0];
    const t = curated
      ? topics.find((x) => x.id === curatedTopicId(curated.topicId, true))
      : (await db.query<{ id: string; name: string }>("SELECT id, name FROM topics WHERE canonical_key = $1", [`demo:${canonicalKey(def.phrase)}`]))[0];
    if (!t) continue;
    const max = Math.max(...shape);
    const series = [];
    for (let h = 7 * 24; h >= 1; h--) {
      const at = now - h * HOUR;
      const day = Math.min(6, Math.floor((at - start) / (24 * HOUR)));
      series.push({ time: new Date(at), value: Math.round(Math.min(100, (100 * shape[day]) / max) * (0.85 + rand() * 0.3)), partial: h === 1 });
    }
    points += await storeInterest(db, "demo_google_trends", [{ topicId: t.id, query: t.name, sourceUrl: "https://example.com/demo/search-interest", points: series }], new Date(now), true);
  }
  await finishRun(db, runId, { status: "success", itemsFetched: points, observationsWritten: points, details: { simulated: true } }, new Date(now));

  // One simulated failure so the status page's error state is visible in demo mode.
  const failId = await startRun(db, "demo_news", "ingest", true, new Date(now - 30 * 60_000));
  await finishRun(db, failId, { status: "failed", error: "Simulated failure (demo data): HTTP 503 from demo news provider" }, new Date(now - 29 * 60_000));

  const ids = topics.map((t) => t.id);
  await deriveObservations(db, ids, new Date(start), new Date(now));

  // Score history: every 6 hours over the last 3 days, oldest first, so the final write is "now".
  for (let h = 72; h >= 0; h -= 6) await scoreAll(db, { asOf: new Date(now - h * HOUR), isDemo: true, cfg });
  const latest = await scoreAll(db, { asOf: new Date(now), isDemo: true, cfg });
  await analyzeTop(db, latest.results, { isDemo: true, limit: 50 });
  return { items: items.length, topics: normalized.topicsActivated };
}
