import type { Db } from "../db";
import { floorToBucket, providerSchedule } from "../config";
import { assignStoryKey, type StoryRef } from "../normalize/grouping";
import { canonicalizeUrl } from "../normalize/text";
import { HttpClient } from "../providers/http";
import type { CollectResult, InterestSeries, ProviderAdapter, RawItem } from "../providers/types";

export interface RunRecord {
  id: number;
  provider: string;
  status: "success" | "partial" | "failed" | "skipped";
  itemsFetched: number;
  itemsNew: number;
  observationsWritten: number;
  requestsMade: number;
  error?: string;
  warnings: string[];
  touchedItemIds: number[];
  touchedTopicIds: string[];
}

export async function startRun(db: Db, provider: string, job: string, isDemo = false, startedAt = new Date()): Promise<number> {
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO ingestion_runs (provider, job, started_at, status, is_demo) VALUES ($1, $2, $3, 'running', $4) RETURNING id",
    [provider, job, startedAt, isDemo],
  );
  return row.id;
}

export async function finishRun(
  db: Db,
  id: number,
  r: { status: string; itemsFetched?: number; itemsNew?: number; observationsWritten?: number; requestsMade?: number; newestItemAt?: Date | null; error?: string | null; details?: unknown },
  finishedAt = new Date(),
): Promise<void> {
  await db.query(
    `UPDATE ingestion_runs SET finished_at = $2, status = $3, items_fetched = $4, items_new = $5, observations_written = $6,
       requests_made = $7, newest_item_at = $8, error_message = $9, details = $10 WHERE id = $1`,
    [id, finishedAt, r.status, r.itemsFetched ?? 0, r.itemsNew ?? 0, r.observationsWritten ?? 0, r.requestsMade ?? 0, r.newestItemAt ?? null, r.error ?? null, JSON.stringify(r.details ?? {})],
  );
}

/** Requests this provider has used in the trailing 24 hours (for daily budgets). */
export async function requestsUsedToday(db: Db, provider: string, now = new Date()): Promise<number> {
  const [row] = await db.query<{ n: number | null }>(
    "SELECT COALESCE(SUM(requests_made), 0)::int8 AS n FROM ingestion_runs WHERE provider = $1 AND job = 'ingest' AND started_at > $2",
    [provider, new Date(now.getTime() - 24 * 3600_000)],
  );
  return Number(row?.n ?? 0);
}

async function recentStoryRefs(db: Db, now: Date, isDemo: boolean): Promise<StoryRef[]> {
  const rows = await db.query<{ story_key: string; fingerprint: string }>(
    `SELECT story_key, meta->>'fingerprint' AS fingerprint FROM source_items
      WHERE first_collected_at > $1 AND is_demo = $2 AND meta ? 'fingerprint'`,
    [new Date(now.getTime() - 72 * 3600_000), isDemo],
  );
  return rows.filter((r) => r.fingerprint).map((r) => ({ storyKey: r.story_key, fingerprint: r.fingerprint }));
}

/**
 * Upserts items and writes one metric snapshot per item per bucket. Idempotent:
 * re-running with the same data rewrites the same rows.
 */
export async function storeItems(
  db: Db,
  provider: string,
  items: RawItem[],
  collectedAt: Date,
  isDemo = false,
): Promise<{ itemIds: number[]; newCount: number; newestPublished: Date | null }> {
  const recent = await recentStoryRefs(db, collectedAt, isDemo);
  const bucket = floorToBucket(collectedAt);
  const itemIds: number[] = [];
  let newCount = 0;
  let newestPublished: Date | null = null;

  for (const it of items) {
    if (!it.title?.trim()) continue;
    const canonical = canonicalizeUrl(it.url);
    const linked = it.linkedUrl ? canonicalizeUrl(it.linkedUrl) : null;
    const [existing] = await db.query<{ id: number; story_key: string }>("SELECT id, story_key FROM source_items WHERE provider = $1 AND external_id = $2", [provider, it.externalId]);
    let id: number;
    if (existing) {
      id = existing.id;
      await db.query(
        `UPDATE source_items SET title = $2, snippet = $3, last_collected_at = $4,
           latest_views = COALESCE($5, latest_views), latest_likes = COALESCE($6, latest_likes), latest_comments = COALESCE($7, latest_comments)
         WHERE id = $1`,
        [id, it.title, it.snippet ?? null, collectedAt, it.views ?? null, it.likes ?? null, it.comments ?? null],
      );
    } else {
      // Articles default to their own URL, so a Reddit post linking that URL shares the story key;
      // syndicated copies at other URLs are still caught by the headline fingerprint.
      const defaultKey = it.contentType === "article" ? `url:${canonical}` : `${provider}:${it.externalId}`;
      const { storyKey, fingerprint } = assignStoryKey({ defaultKey, title: it.title, linkedUrl: linked, recent });
      const rows = await db.query<{ id: number }>(
        `INSERT INTO source_items (provider, external_id, url, canonical_url, story_key, content_type, title, snippet, author, published_at,
            first_collected_at, last_collected_at, latest_views, latest_likes, latest_comments, meta, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (provider, external_id) DO UPDATE SET last_collected_at = EXCLUDED.last_collected_at
         RETURNING id`,
        [
          provider,
          it.externalId,
          it.url,
          canonical,
          storyKey,
          it.contentType,
          it.title,
          it.snippet ?? null,
          it.author ?? null,
          it.publishedAt ?? null,
          collectedAt,
          it.views ?? null,
          it.likes ?? null,
          it.comments ?? null,
          JSON.stringify({ ...(it.meta ?? {}), fingerprint, linkedUrl: linked }),
          isDemo,
        ],
      );
      id = rows[0].id;
      newCount++;
      recent.push({ storyKey, fingerprint });
    }
    itemIds.push(id);
    if (it.publishedAt && (!newestPublished || it.publishedAt > newestPublished)) newestPublished = it.publishedAt;

    if (it.views != null || it.likes != null || it.comments != null || it.rank != null) {
      await db.query(
        `INSERT INTO item_metric_snapshots (item_id, bucket_at, observed_at, views, likes, comments, source_rank)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (item_id, bucket_at) DO UPDATE SET observed_at = EXCLUDED.observed_at, views = EXCLUDED.views,
           likes = EXCLUDED.likes, comments = EXCLUDED.comments, source_rank = LEAST(item_metric_snapshots.source_rank, EXCLUDED.source_rank)`,
        [id, bucket, collectedAt, it.views ?? null, it.likes ?? null, it.comments ?? null, it.rank ?? null],
      );
    }
  }
  return { itemIds, newCount, newestPublished };
}

/** Writes search-interest points. Each run replaces the stored timeframe because Google re-normalizes it. */
export async function storeInterest(db: Db, source: string, series: InterestSeries[], collectedAt: Date, isDemo = false): Promise<number> {
  let written = 0;
  for (const s of series) {
    if (s.points.length === 0) continue;
    const from = s.points.reduce((m, p) => (p.time < m ? p.time : m), s.points[0].time);
    await db.transaction(async (tx) => {
      await tx.query("DELETE FROM observations WHERE topic_id = $1 AND source = $2 AND observed_at >= $3", [s.topicId, source, floorToBucket(from)]);
      // Hourly points are stored per bucket; finer points are averaged into their bucket.
      const buckets = new Map<number, { sum: number; n: number; partial: boolean }>();
      for (const p of s.points) {
        const b = floorToBucket(p.time).getTime();
        const cur = buckets.get(b) ?? { sum: 0, n: 0, partial: false };
        cur.sum += p.value;
        cur.n++;
        cur.partial ||= p.partial;
        buckets.set(b, cur);
      }
      for (const [b, v] of buckets) {
        await tx.query(
          `INSERT INTO observations (topic_id, source, observed_at, collected_at, search_interest, sample_size, data_quality, source_url, is_demo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (topic_id, source, observed_at) DO UPDATE SET collected_at = EXCLUDED.collected_at, search_interest = EXCLUDED.search_interest,
             sample_size = EXCLUDED.sample_size, data_quality = EXCLUDED.data_quality, source_url = EXCLUDED.source_url`,
          // Google marks the latest point as partial (incomplete period): it is kept, at reduced quality.
          [s.topicId, source, new Date(b), collectedAt, v.sum / v.n, v.n, v.partial ? 0.5 : 1, s.sourceUrl, isDemo],
        );
        written++;
      }
    });
  }
  return written;
}

/** Purges stored text for content the provider reports as removed (Reddit Data API terms). */
export async function purgeRemoved(db: Db, provider: string, externalIds: string[]): Promise<void> {
  if (externalIds.length === 0) return;
  await db.query(
    `UPDATE source_items SET title = '[removed by author or moderator]', snippet = NULL, meta = meta - 'fingerprint'
      WHERE provider = $1 AND external_id = ANY($2)`,
    [provider, externalIds],
  );
}

/**
 * Runs one provider end to end: budget check, collection, storage, run record.
 * Normalization and observation derivation are run by the orchestrator afterwards.
 */
export async function ingestProvider(db: Db, adapter: ProviderAdapter, env: Record<string, string | undefined> = process.env, now = new Date()): Promise<RunRecord> {
  const runId = await startRun(db, adapter.name, "ingest", false, now);
  const base: RunRecord = { id: runId, provider: adapter.name, status: "skipped", itemsFetched: 0, itemsNew: 0, observationsWritten: 0, requestsMade: 0, warnings: [], touchedItemIds: [], touchedTopicIds: [] };

  const config = adapter.configStatus(env);
  if (!config.configured) {
    const error = `not configured: missing ${config.missing.join(", ")}`;
    await finishRun(db, runId, { status: "skipped", error, details: { reason: "missing_credentials", missing: config.missing } });
    return { ...base, error };
  }

  const schedule = providerSchedule(adapter.name, env);
  const used = await requestsUsedToday(db, adapter.name, now);
  const budget = schedule.dailyRequestBudget - used;
  if (budget <= 0) {
    const error = `daily request budget (${schedule.dailyRequestBudget}) exhausted`;
    await finishRun(db, runId, { status: "skipped", error, details: { reason: "budget", used } });
    return { ...base, error };
  }

  const http = new HttpClient({ provider: adapter.name, budget, minIntervalMs: adapter.minIntervalMs, userAgent: adapter.userAgent?.(env), secrets: adapter.secrets(env) });
  let result: CollectResult;
  try {
    result = await adapter.collect({
      now,
      http,
      env,
      trackedExternalIds: async (sinceDays) =>
        (
          await db.query<{ external_id: string }>(
            "SELECT external_id FROM source_items WHERE provider = $1 AND is_demo = FALSE AND COALESCE(published_at, first_collected_at) > $2 ORDER BY first_collected_at DESC LIMIT 2000",
            [adapter.name, new Date(now.getTime() - sinceDays * 86400_000)],
          )
        ).map((r) => r.external_id),
      topicsForInterest: async (limit) =>
        (
          await db.query<{ topic_id: string; name: string }>(
            `SELECT t.id AS topic_id, t.name FROM topics t LEFT JOIN trend_scores s ON s.topic_id = t.id
              WHERE t.status = 'active' AND t.is_demo = FALSE ORDER BY s.trend_score DESC NULLS LAST, t.last_seen_at DESC LIMIT $1`,
            [limit],
          )
        ).map((r) => ({ topicId: r.topic_id, query: r.name.replace(/\s*\(.*\)\s*$/, "") })),
    });
  } catch (err) {
    const error = http.redact((err as Error).message);
    await finishRun(db, runId, { status: "failed", requestsMade: http.requests, error });
    return { ...base, status: "failed", requestsMade: http.requests, error };
  }

  const stored = await storeItems(db, adapter.name, result.items, now);
  await purgeRemoved(db, adapter.name, result.removedExternalIds ?? []);
  const interestWritten = result.interest ? await storeInterest(db, adapter.name, result.interest, now) : 0;
  const fetched = result.items.length + (result.interest?.reduce((a, s) => a + s.points.length, 0) ?? 0);
  // A run that fetched nothing because every request failed is a failure, not a success.
  const status: RunRecord["status"] = fetched === 0 && result.warnings.length > 0 ? "failed" : result.warnings.length > 0 ? "partial" : "success";
  await finishRun(db, runId, {
    status,
    itemsFetched: fetched,
    itemsNew: stored.newCount,
    observationsWritten: interestWritten,
    requestsMade: http.requests,
    newestItemAt: stored.newestPublished,
    error: result.warnings.length ? result.warnings.slice(0, 5).join(" | ") : null,
    details: { warnings: result.warnings.slice(0, 50) },
  });
  return {
    ...base,
    status,
    itemsFetched: fetched,
    itemsNew: stored.newCount,
    observationsWritten: interestWritten,
    requestsMade: http.requests,
    warnings: result.warnings,
    error: result.warnings.length ? result.warnings.slice(0, 3).join(" | ") : undefined,
    touchedItemIds: stored.itemIds,
    touchedTopicIds: result.interest?.map((s) => s.topicId) ?? [],
  };
}
