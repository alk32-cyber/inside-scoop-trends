import { z } from "zod";
import { getDb, isEphemeralDb, type Db } from "../db";
import { categories, fallbackCategory, providerSchedule, sourceProfiles } from "../config";
import { providers } from "../providers";
import { llmConfigured } from "../analysis/generate";
import type { StoredAnalysis } from "../analysis/schema";

export function isDemoMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE === "true" || env.DEMO_MODE === "1";
}

const LIFECYCLES = ["emerging", "rising", "breakout", "peaking", "cooling", "dormant", "stable", "insufficient_data"] as const;
export const VIEWS = ["all", "emerging", "breakout", "most_discussed", "momentum", "cooling", "opportunities"] as const;
const SOURCES = ["youtube", "reddit", "news", "google_trends"] as const;
const WINDOWS = { "24h": 24, "72h": 72, "7d": 168 } as const;

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const TrendsQuery = z.object({
  view: z.enum(VIEWS).default("all"),
  category: csv(categories.map((c) => c.id).concat(fallbackCategory.id) as [string, ...string[]]).optional(),
  source: csv(SOURCES).optional(),
  lifecycle: csv(LIFECYCLES).optional(),
  minConfidence: z.coerce.number().min(0).max(100).default(0),
  window: z.enum(Object.keys(WINDOWS) as [keyof typeof WINDOWS, ...Array<keyof typeof WINDOWS>]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type TrendsQuery = z.infer<typeof TrendsQuery>;

export const TopicId = z.string().regex(/^[a-z0-9-]{1,100}$/);
export const SourcesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) });

export function confidenceLevel(c: number): "high" | "medium" | "low" {
  return c >= 70 ? "high" : c >= 40 ? "medium" : "low";
}

/**
 * Editorial ranking for "best content opportunities": trend strength first, then
 * fit with the show, then how sure we are. Shown separately from the trend score.
 */
export function opportunityScore(trend: number, relevance: number | null, confidence: number): number {
  return Math.round((0.6 * trend + 0.25 * (relevance ?? 20) + 0.15 * confidence) * 10) / 10;
}

const categoryLabel = (id: string) => categories.find((c) => c.id === id)?.label ?? fallbackCategory.label;

// Tiny TTL cache: protects the database from dashboard polling. Keys include the data mode.
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = Number(process.env.API_CACHE_TTL_MS ?? 30_000);
export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}
export function clearCache(): void {
  cache.clear();
}

interface TrendRow {
  topic_id: string;
  name: string;
  category: string;
  trend_score: number;
  score_change_24h: number | null;
  lifecycle: string;
  confidence: number;
  velocity_score: number | null;
  engagement_score: number | null;
  cross_platform_score: number | null;
  attention_score: number | null;
  relevance_score: number | null;
  missing_components: string[];
  flags: string[];
  sources: string[];
  computed_at: Date;
  as_of: Date;
  details: Record<string, unknown>;
  last_seen_at: Date;
  data_as_of: Date | null;
  payload: StoredAnalysis | null;
  is_demo: boolean;
  total: number;
}

function displaySource(s: string): string {
  return s.replace(/^demo_/, "");
}

function toTrend(r: TrendRow, staleAfterMs: number) {
  const details = r.details as { lifecycleReason?: string; attentionRaw?: number | null; independentSources?: number };
  const lowConf = r.flags.includes("high_score_low_confidence");
  const dataAge = r.data_as_of ? Date.now() - new Date(r.data_as_of).getTime() : null;
  return {
    id: r.topic_id,
    name: r.name,
    category: r.category,
    categoryLabel: categoryLabel(r.category),
    trendScore: r.trend_score,
    scoreChange24h: r.score_change_24h,
    lifecycle: r.lifecycle,
    lifecycleReason: details.lifecycleReason ?? null,
    confidence: r.confidence,
    confidenceLevel: confidenceLevel(r.confidence),
    highScoreLowConfidence: lowConf,
    sourceCount: r.sources.length,
    independentSources: details.independentSources ?? null,
    sources: r.sources.map(displaySource),
    components: {
      velocity: r.velocity_score,
      engagement: r.engagement_score,
      crossPlatform: r.cross_platform_score,
      attention: r.attention_score,
      relevance: r.relevance_score,
    },
    missingComponents: r.missing_components,
    flags: r.flags,
    opportunityScore: opportunityScore(r.trend_score, r.relevance_score, r.confidence),
    explanation: r.payload?.evidence_sufficient ? r.payload.why_rising : (details.lifecycleReason ?? null),
    explanationIsAnalysis: Boolean(r.payload?.evidence_sufficient),
    topAngle: r.payload?.content_angles?.[0] ?? null,
    analysisMethod: r.payload?.method ?? null,
    lastUpdated: new Date(r.computed_at).toISOString(),
    scoredAsOf: new Date(r.as_of).toISOString(),
    dataAsOf: r.data_as_of ? new Date(r.data_as_of).toISOString() : null,
    stale: dataAge === null || dataAge > staleAfterMs,
    isDemo: r.is_demo,
  };
}
export type TrendItem = ReturnType<typeof toTrend>;

/** Data older than this is shown as stale rather than live. */
export function staleAfterMs(env: Record<string, string | undefined> = process.env): number {
  return Number(env.STALE_AFTER_HOURS ?? 12) * 3600_000;
}

export async function listTrends(q: TrendsQuery, opts: { db?: Db; demo?: boolean } = {}) {
  const db = opts.db ?? (await getDb());
  const demo = opts.demo ?? isDemoMode();
  const where: string[] = ["s.is_demo = $1", "t.status = 'active'", "s.confidence >= $2"];
  const params: unknown[] = [demo, q.minConfidence];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (q.category?.length) add("t.category = ANY(?)", q.category);
  if (q.source?.length) add("s.sources && ?", q.source.map((s) => (demo ? `demo_${s}` : s)));
  const from = q.from ? new Date(q.from) : q.window ? new Date(Date.now() - WINDOWS[q.window] * 3600_000) : null;
  if (from) add("t.last_seen_at >= ?", from);
  if (q.to) add("t.first_seen_at <= ?", new Date(q.to));

  let lifecycles = q.lifecycle;
  let order = "s.trend_score DESC, s.confidence DESC, s.topic_id ASC";
  switch (q.view) {
    case "emerging":
      lifecycles = ["emerging"];
      break;
    case "breakout":
      lifecycles = ["breakout"];
      break;
    case "most_discussed":
      order = "COALESCE((s.details->>'attentionRaw')::float8, 0) DESC, s.trend_score DESC, s.topic_id ASC";
      break;
    case "momentum":
      lifecycles = lifecycles ?? ["emerging", "rising", "breakout"];
      order = "COALESCE(s.score_change_24h, 0) DESC, s.velocity_score DESC NULLS LAST, s.topic_id ASC";
      break;
    case "cooling":
      lifecycles = ["cooling", "peaking"];
      order = "s.velocity_score ASC NULLS LAST, s.topic_id ASC";
      break;
    case "opportunities":
      lifecycles = lifecycles ?? ["emerging", "rising", "breakout", "peaking", "stable"];
      // Opportunities are things we would actually recommend: never below medium confidence.
      if (q.minConfidence < 40) params[1] = 40;
      order = "(0.6 * s.trend_score + 0.25 * COALESCE(s.relevance_score, 20) + 0.15 * s.confidence) DESC, s.topic_id ASC";
      break;
  }
  if (lifecycles?.length) add("s.lifecycle = ANY(?)", lifecycles);
  params.push(q.limit, q.offset);

  const rows = await db.query<TrendRow>(
    `SELECT s.*, t.name, t.category, t.last_seen_at,
            (SELECT MAX(o.collected_at) FROM observations o WHERE o.topic_id = s.topic_id) AS data_as_of,
            (SELECT c.payload FROM content_recommendations c WHERE c.topic_id = s.topic_id ORDER BY c.data_timestamp DESC, c.generated_at DESC LIMIT 1) AS payload,
            COUNT(*) OVER()::int8 AS total
       FROM trend_scores s JOIN topics t ON t.id = s.topic_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const stale = staleAfterMs();
  return {
    mode: demo ? ("demo" as const) : ("live" as const),
    view: q.view,
    total: rows[0]?.total ?? 0,
    limit: q.limit,
    offset: q.offset,
    timezone: "UTC",
    items: rows.map((r) => toTrend(r, stale)),
  };
}

export async function getTrend(id: string, opts: { db?: Db; demo?: boolean } = {}) {
  const db = opts.db ?? (await getDb());
  const demo = opts.demo ?? isDemoMode();
  const [row] = await db.query<TrendRow>(
    `SELECT s.*, t.name, t.category, t.last_seen_at,
            (SELECT MAX(o.collected_at) FROM observations o WHERE o.topic_id = s.topic_id) AS data_as_of,
            (SELECT c.payload FROM content_recommendations c WHERE c.topic_id = s.topic_id ORDER BY c.data_timestamp DESC, c.generated_at DESC LIMIT 1) AS payload,
            1::int8 AS total
       FROM trend_scores s JOIN topics t ON t.id = s.topic_id WHERE s.topic_id = $1 AND s.is_demo = $2`,
    [id, demo],
  );
  if (!row) return null;
  const [topic] = await db.query<{ first_seen_at: Date; origin: string }>("SELECT first_seen_at, origin FROM topics WHERE id = $1", [id]);
  const aliases = (await db.query<{ alias: string }>("SELECT alias FROM topic_aliases WHERE topic_id = $1 ORDER BY alias", [id])).map((a) => a.alias);
  const history = await db.query<{ as_of: Date; trend_score: number; confidence: number; lifecycle: string }>(
    "SELECT as_of, trend_score, confidence, lifecycle FROM trend_score_history WHERE topic_id = $1 AND as_of > $2 ORDER BY as_of",
    [id, new Date(Date.now() - 14 * 86400_000)],
  );
  // Activity per source in rolling 24h windows ending at the score's as-of time (same windows the
  // scoring engine uses, so the newest point is never a partial calendar day). Units differ per
  // source, so each source is charted separately.
  const asOf = new Date(row.as_of);
  const activity = await db.query<{ source: string; w: number; posts: number | null; views: number | null; discussion: number | null; interest: number | null }>(
    `SELECT source, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - observed_at)) / 86400)::int AS w,
            SUM(COALESCE(unique_stories, new_posts))::int8 AS posts, SUM(new_views)::int8 AS views,
            SUM(COALESCE(new_posts, 0) + COALESCE(new_comments, 0))::int8 AS discussion, AVG(search_interest) AS interest
       FROM observations WHERE topic_id = $1 AND observed_at <= $2 AND observed_at > $2::timestamptz - interval '7 days'
      GROUP BY 1, 2 ORDER BY 2 DESC`,
    [id, asOf],
  );
  const evidence = await topSources(db, id, 8, 0);
  return {
    mode: demo ? "demo" : "live",
    timezone: "UTC",
    topic: { ...toTrend(row, staleAfterMs()), aliases, firstSeenAt: new Date(topic.first_seen_at).toISOString(), origin: topic.origin },
    breakdown: row.details,
    history: history.map((h) => ({ asOf: new Date(h.as_of).toISOString(), trendScore: h.trend_score, confidence: h.confidence, lifecycle: h.lifecycle })),
    activity: activity.map((a) => ({
      source: displaySource(a.source),
      windowEnd: new Date(asOf.getTime() - a.w * 86400_000).toISOString(),
      metric: sourceProfiles[a.source]?.volumeMetric ?? "new_posts",
      value:
        sourceProfiles[a.source]?.volumeMetric === "search_interest"
          ? Math.round((a.interest ?? 0) * 10) / 10
          : sourceProfiles[a.source]?.volumeMetric === "new_views"
            ? a.views
            : sourceProfiles[a.source]?.volumeMetric === "discussion"
              ? a.discussion
              : a.posts,
    })),
    evidence: evidence.items,
    analysis: row.payload,
  };
}

async function topSources(db: Db, id: string, limit: number, offset: number) {
  const rows = await db.query<{
    id: number;
    provider: string;
    url: string;
    title: string;
    author: string | null;
    published_at: Date | null;
    first_collected_at: Date;
    last_collected_at: Date;
    latest_views: number | null;
    latest_likes: number | null;
    latest_comments: number | null;
    story_key: string;
    match_method: string;
    matched_text: string | null;
    content_type: string;
    total: number;
  }>(
    `SELECT i.id, i.provider, i.url, i.title, i.author, i.published_at, i.first_collected_at, i.last_collected_at, i.latest_views, i.latest_likes,
            i.latest_comments, i.story_key, i.content_type, l.match_method, l.matched_text, COUNT(*) OVER()::int8 AS total
       FROM topic_source_links l JOIN source_items i ON i.id = l.source_item_id
      WHERE l.topic_id = $1
      ORDER BY i.published_at DESC NULLS LAST, i.id DESC LIMIT $2 OFFSET $3`,
    [id, limit, offset],
  );
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      provider: displaySource(r.provider),
      isDemo: r.provider.startsWith("demo_"),
      contentType: r.content_type,
      title: r.title,
      url: r.url,
      author: r.author,
      publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
      collectedAt: new Date(r.first_collected_at).toISOString(),
      lastCollectedAt: new Date(r.last_collected_at).toISOString(),
      views: r.latest_views,
      likes: r.latest_likes,
      comments: r.latest_comments,
      storyKey: r.story_key,
      matchMethod: r.match_method,
      matchedText: r.matched_text,
    })),
  };
}

export async function getSources(id: string, q: z.infer<typeof SourcesQuery>, opts: { db?: Db; demo?: boolean } = {}) {
  const db = opts.db ?? (await getDb());
  const demo = opts.demo ?? isDemoMode();
  const [exists] = await db.query("SELECT 1 FROM topics WHERE id = $1 AND is_demo = $2", [id, demo]);
  if (!exists) return null;
  const res = await topSources(db, id, q.limit, q.offset);
  return { topicId: id, timezone: "UTC", limit: q.limit, offset: q.offset, ...res };
}

export async function getContentIdeas(id: string, opts: { db?: Db; demo?: boolean } = {}) {
  const db = opts.db ?? (await getDb());
  const demo = opts.demo ?? isDemoMode();
  const [exists] = await db.query("SELECT 1 FROM topics WHERE id = $1 AND is_demo = $2", [id, demo]);
  if (!exists) return null;
  const [row] = await db.query<{ payload: StoredAnalysis; generated_at: Date; data_timestamp: Date; method: string; model: string | null }>(
    "SELECT payload, generated_at, data_timestamp, method, model FROM content_recommendations WHERE topic_id = $1 ORDER BY data_timestamp DESC, generated_at DESC LIMIT 1",
    [id],
  );
  return {
    topicId: id,
    available: Boolean(row),
    method: row?.method ?? null,
    model: row?.model ?? null,
    generatedAt: row ? new Date(row.generated_at).toISOString() : null,
    dataTimestamp: row ? new Date(row.data_timestamp).toISOString() : null,
    analysis: row?.payload ?? null,
  };
}

export async function systemStatus(opts: { db?: Db; demo?: boolean; env?: Record<string, string | undefined> } = {}) {
  const db = opts.db ?? (await getDb());
  const demo = opts.demo ?? isDemoMode();
  const env = opts.env ?? process.env;
  const now = Date.now();
  const providerRows = [];
  for (const p of providers) {
    const name = demo ? `demo_${p.name}` : p.name;
    const cfg = p.configStatus(env);
    const [lastAttempt] = await db.query<{ started_at: Date; status: string; error_message: string | null; items_fetched: number; requests_made: number }>(
      "SELECT started_at, status, error_message, items_fetched, requests_made FROM ingestion_runs WHERE provider = $1 AND job = 'ingest' ORDER BY started_at DESC, id DESC LIMIT 1",
      [name],
    );
    const [lastSuccess] = await db.query<{ started_at: Date; finished_at: Date | null; newest_item_at: Date | null; items_fetched: number }>(
      "SELECT started_at, finished_at, newest_item_at, items_fetched FROM ingestion_runs WHERE provider = $1 AND job = 'ingest' AND status IN ('success', 'partial') ORDER BY started_at DESC, id DESC LIMIT 1",
      [name],
    );
    const [lastError] = await db.query<{ started_at: Date; error_message: string | null; status: string }>(
      "SELECT started_at, error_message, status FROM ingestion_runs WHERE provider = $1 AND job = 'ingest' AND status IN ('failed', 'partial') AND error_message IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1",
      [name],
    );
    const [counts] = await db.query<{ runs: number; failures: number; requests: number }>(
      `SELECT COUNT(*)::int8 AS runs, COUNT(*) FILTER (WHERE status = 'failed')::int8 AS failures, COALESCE(SUM(requests_made), 0)::int8 AS requests
         FROM ingestion_runs WHERE provider = $1 AND job = 'ingest' AND started_at > $2`,
      [name, new Date(now - 86400_000)],
    );
    const staleAfter = (sourceProfiles[p.name]?.staleAfterHours ?? 12) * 3600_000;
    const successAge = lastSuccess ? now - new Date(lastSuccess.started_at).getTime() : null;
    // "connected" is only ever claimed after a successful collection has been recorded.
    let connection: "demo" | "connected" | "configured_untested" | "not_configured" | "failing";
    if (demo) connection = "demo";
    else if (!cfg.configured) connection = "not_configured";
    else if (!lastSuccess) connection = lastAttempt?.status === "failed" ? "failing" : "configured_untested";
    else connection = lastAttempt?.status === "failed" ? "failing" : "connected";
    const schedule = providerSchedule(p.name, env);
    providerRows.push({
      provider: p.name,
      label: p.label,
      attribution: p.attribution,
      docsUrl: p.docsUrl,
      connection,
      configured: cfg.configured,
      missingEnv: cfg.missing,
      notes: cfg.notes ?? null,
      scheduleMinutes: schedule.intervalMinutes,
      dailyRequestBudget: schedule.dailyRequestBudget,
      requestsLast24h: counts?.requests ?? 0,
      runsLast24h: counts?.runs ?? 0,
      failuresLast24h: counts?.failures ?? 0,
      lastAttemptAt: lastAttempt ? new Date(lastAttempt.started_at).toISOString() : null,
      lastAttemptStatus: lastAttempt?.status ?? null,
      lastSuccessAt: lastSuccess ? new Date(lastSuccess.started_at).toISOString() : null,
      newestItemAt: lastSuccess?.newest_item_at ? new Date(lastSuccess.newest_item_at).toISOString() : null,
      stale: successAge === null || successAge > staleAfter,
      staleAfterHours: staleAfter / 3600_000,
      lastError: lastError ? { at: new Date(lastError.started_at).toISOString(), status: lastError.status, message: lastError.error_message } : null,
    });
  }
  const [pipeline] = await db.query<{ started_at: Date; status: string; error_message: string | null }>(
    "SELECT started_at, status, error_message FROM ingestion_runs WHERE provider = 'pipeline' ORDER BY started_at DESC, id DESC LIMIT 1",
  );
  const [scores] = await db.query<{ n: number; latest: Date | null }>("SELECT COUNT(*)::int8 AS n, MAX(computed_at) AS latest FROM trend_scores WHERE is_demo = $1", [demo]);
  return {
    mode: demo ? "demo" : "live",
    now: new Date(now).toISOString(),
    timezone: "UTC",
    providers: providerRows,
    pipeline: pipeline ? { lastRunAt: new Date(pipeline.started_at).toISOString(), status: pipeline.status, error: pipeline.error_message } : null,
    scoring: { topicsScored: scores?.n ?? 0, lastScoredAt: scores?.latest ? new Date(scores.latest).toISOString() : null },
    analysis: { llmConfigured: llmConfigured(env), model: env.ANALYSIS_MODEL ?? "claude-opus-5-5" },
    embeddings: { configured: Boolean(env.VOYAGE_API_KEY) },
    database: env.DATABASE_URL ? "postgres" : isEphemeralDb(env) ? "in-memory (not persistent — set DATABASE_URL)" : "pglite (local file)",
    persistent: !isEphemeralDb(env),
  };
}
