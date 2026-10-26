import type { Db } from "../db";
import { loadScoringConfig, sourceProfiles, type ScoringConfig } from "../config";
import { assignCategory } from "../normalize/grouping";
import { buildPopulation, rankResults, scoreTopic, type Coverage, type ObservationInput, type ScoreResult, type TopicInput } from "../scoring/score";

interface ObsRow {
  topic_id: string;
  source: string;
  observed_at: Date;
  collected_at: Date;
  search_interest: number | null;
  new_posts: number | null;
  new_views: number | null;
  new_likes: number | null;
  new_comments: number | null;
  sample_size: number;
  unique_stories: number | null;
  data_quality: number;
}

/**
 * Builds window coverage from ingestion runs: a window is covered for a source when
 * that provider completed a successful or partial ingest inside it.
 */
export async function loadCoverage(db: Db, asOf: Date, cfg: ScoringConfig, isDemo: boolean): Promise<Coverage> {
  const W = cfg.windowHours * 3600_000;
  const n = cfg.baselineWindows + 1;
  const runs = await db.query<{ provider: string; started_at: Date }>(
    `SELECT provider, started_at FROM ingestion_runs
      WHERE job = 'ingest' AND status IN ('success', 'partial') AND is_demo = $1 AND started_at > $2 AND started_at <= $3`,
    [isDemo, new Date(asOf.getTime() - n * W), asOf],
  );
  const coverage: Coverage = {};
  for (const r of runs) {
    // Ingestion runs are recorded under the source name they produce (youtube, demo_reddit, ...).
    const source = sourceProfiles[r.provider] ? r.provider : undefined;
    // Search-interest sources only cover the topics they actually queried; their rows speak for themselves.
    if (!source || sourceProfiles[source].volumeMetric === "search_interest") continue;
    const w = Math.floor((asOf.getTime() - new Date(r.started_at).getTime()) / W);
    if (w < 0 || w >= n) continue;
    (coverage[source] ??= Array(n).fill(false))[w] = true;
  }
  return coverage;
}

export interface ScoreRunResult {
  asOf: Date;
  scored: number;
  results: ScoreResult[];
}

/** Loads everything the scoring engine needs for one as-of time. Shared by live scoring and backtests. */
export async function loadTopicInputs(db: Db, asOf: Date, cfg: ScoringConfig, isDemo: boolean, opts: { topicIds?: string[] } = {}): Promise<TopicInput[]> {
  const W = cfg.windowHours * 3600_000;
  const from = new Date(asOf.getTime() - (cfg.baselineWindows + 1) * W);
  const topics = await db.query<{ id: string; name: string; category: string; first_seen_at: Date }>(
    `SELECT id, name, category, first_seen_at FROM topics
      WHERE status = 'active' AND is_demo = $1 AND first_seen_at <= $2 AND ($3::text[] IS NULL OR id = ANY($3))`,
    [isDemo, asOf, opts.topicIds ?? null],
  );
  if (topics.length === 0) return [];
  const ids = topics.map((t) => t.id);

  const obs = await db.query<ObsRow>(
    `SELECT topic_id, source, observed_at, collected_at, search_interest, new_posts, new_views, new_likes, new_comments,
            sample_size, unique_stories, data_quality
       FROM observations WHERE topic_id = ANY($1) AND observed_at > $2 AND observed_at <= $3 AND collected_at <= $4`,
    // collected_at <= asOf + 1 bucket keeps backtests from seeing observations collected after the cutoff.
    [ids, from, asOf, new Date(asOf.getTime() + 3600_000)],
  );
  const stories = await db.query<{ topic_id: string; provider: string; keys: string[] }>(
    `SELECT l.topic_id, i.provider, ARRAY_AGG(DISTINCT i.story_key) AS keys
       FROM topic_source_links l JOIN source_items i ON i.id = l.source_item_id
      WHERE l.topic_id = ANY($1) AND COALESCE(i.published_at, i.first_collected_at) > $2 AND COALESCE(i.published_at, i.first_collected_at) <= $3
      GROUP BY l.topic_id, i.provider`,
    [ids, new Date(asOf.getTime() - W), asOf],
  );
  const titles = await db.query<{ topic_id: string; titles: string[] }>(
    `SELECT l.topic_id, (ARRAY_AGG(i.title ORDER BY i.first_collected_at DESC))[1:25] AS titles
       FROM topic_source_links l JOIN source_items i ON i.id = l.source_item_id WHERE l.topic_id = ANY($1) GROUP BY l.topic_id`,
    [ids],
  );

  const obsBy = new Map<string, ObservationInput[]>();
  for (const o of obs) {
    const list = obsBy.get(o.topic_id) ?? [];
    list.push({
      source: o.source,
      observedAt: new Date(o.observed_at),
      collectedAt: new Date(o.collected_at),
      searchInterest: o.search_interest,
      newPosts: o.new_posts,
      newViews: o.new_views,
      newLikes: o.new_likes,
      newComments: o.new_comments,
      sampleSize: o.sample_size,
      uniqueStories: o.unique_stories,
      dataQuality: o.data_quality,
    });
    obsBy.set(o.topic_id, list);
  }
  const storiesBy = new Map<string, Record<string, string[]>>();
  for (const s of stories) {
    const rec = storiesBy.get(s.topic_id) ?? {};
    rec[s.provider] = s.keys;
    storiesBy.set(s.topic_id, rec);
  }
  const titlesBy = new Map(titles.map((t) => [t.topic_id, t.titles]));

  return topics.map((t) => ({
    topicId: t.id,
    relevance: assignCategory(t.name, titlesBy.get(t.id) ?? [], t.category).relevance,
    observations: obsBy.get(t.id) ?? [],
    recentStories: storiesBy.get(t.id) ?? {},
    firstSeenAt: new Date(t.first_seen_at),
  }));
}

/** Scores all active topics as of `asOf`, writes trend_scores + trend_score_history. */
export async function scoreAll(db: Db, opts: { asOf?: Date; isDemo?: boolean; cfg?: ScoringConfig; write?: boolean } = {}): Promise<ScoreRunResult> {
  const asOf = opts.asOf ?? new Date();
  const cfg = opts.cfg ?? loadScoringConfig();
  const isDemo = opts.isDemo ?? false;
  const inputs = await loadTopicInputs(db, asOf, cfg, isDemo);
  const coverage = await loadCoverage(db, asOf, cfg, isDemo);
  const population = buildPopulation(inputs, asOf, cfg, coverage);
  const results = rankResults(inputs.map((t) => scoreTopic(t, asOf, cfg, { coverage, population })));

  if (opts.write !== false) {
    const computedAt = new Date();
    for (const r of results) {
      const [prev] = await db.query<{ trend_score: number }>(
        `SELECT trend_score FROM trend_score_history WHERE topic_id = $1 AND as_of BETWEEN $2 AND $3
          ORDER BY ABS(EXTRACT(EPOCH FROM (as_of - $4::timestamptz))) LIMIT 1`,
        [r.topicId, new Date(asOf.getTime() - 27 * 3600_000), new Date(asOf.getTime() - 21 * 3600_000), new Date(asOf.getTime() - 24 * 3600_000)],
      );
      const change = prev ? Math.round((r.trendScore - prev.trend_score) * 10) / 10 : null;
      const details = {
        perSource: r.perSource,
        confidenceParts: r.confidenceParts,
        lifecycleReason: r.lifecycleReason,
        coverage: r.coverage,
        attentionRaw: r.attentionRaw,
        independentSources: r.independentSources,
        uniqueStories: r.uniqueStories,
        totalSample: r.totalSample,
        aggregateLogGrowth: r.aggregateLogGrowth,
        aggregateAcceleration: r.aggregateAcceleration,
        weights: cfg.weights,
        windowHours: cfg.windowHours,
      };
      await db.query(
        `INSERT INTO trend_scores (topic_id, computed_at, as_of, window_hours, trend_score, velocity_score, engagement_score, cross_platform_score,
            attention_score, relevance_score, confidence, lifecycle, score_change_24h, missing_components, flags, sources, details, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (topic_id) DO UPDATE SET computed_at = EXCLUDED.computed_at, as_of = EXCLUDED.as_of, window_hours = EXCLUDED.window_hours,
           trend_score = EXCLUDED.trend_score, velocity_score = EXCLUDED.velocity_score, engagement_score = EXCLUDED.engagement_score,
           cross_platform_score = EXCLUDED.cross_platform_score, attention_score = EXCLUDED.attention_score, relevance_score = EXCLUDED.relevance_score,
           confidence = EXCLUDED.confidence, lifecycle = EXCLUDED.lifecycle, score_change_24h = EXCLUDED.score_change_24h,
           missing_components = EXCLUDED.missing_components, flags = EXCLUDED.flags, sources = EXCLUDED.sources, details = EXCLUDED.details`,
        [
          r.topicId,
          computedAt,
          asOf,
          cfg.windowHours,
          r.trendScore,
          r.components.velocity,
          r.components.engagement,
          r.components.crossPlatform,
          r.components.attention,
          r.components.relevance,
          r.confidence,
          r.lifecycle,
          change,
          r.missingComponents,
          isDemo ? [...r.flags, "demo_data"] : r.flags,
          r.sourcesWithData,
          JSON.stringify(details),
          isDemo,
        ],
      );
      await db.query(
        `INSERT INTO trend_score_history (topic_id, as_of, computed_at, trend_score, confidence, lifecycle, components, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (topic_id, as_of) DO UPDATE SET computed_at = EXCLUDED.computed_at, trend_score = EXCLUDED.trend_score,
           confidence = EXCLUDED.confidence, lifecycle = EXCLUDED.lifecycle, components = EXCLUDED.components`,
        [r.topicId, asOf, computedAt, r.trendScore, r.confidence, r.lifecycle, JSON.stringify(r.components), isDemo],
      );
    }
  }
  return { asOf, scored: results.length, results };
}
