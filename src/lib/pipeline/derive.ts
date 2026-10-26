import type { Db } from "../db";

/** Providers whose observations are derived from items + snapshots (search interest is stored directly). */
export const ITEM_SOURCES = ["youtube", "reddit", "news", "demo_youtube", "demo_reddit", "demo_news"];

/** How long after publication a first snapshot may still be fully attributed as "new" activity. */
const FIRST_SNAPSHOT_ATTRIBUTION_HOURS = 24;

/**
 * Rebuilds item-derived observations for the given topics from `from` onwards.
 *
 *  new_posts       items published in the bucket
 *  unique_stories  stories whose first copy appeared in the bucket (syndicated copies and
 *                  later reposts of the same story are never counted again)
 *  new_views/likes/comments
 *                  increase between an item's consecutive snapshots, attributed to the later
 *                  snapshot's bucket. An item's first snapshot only counts if the item was
 *                  published within 24h of it (otherwise we cannot know when those views happened).
 *  data_quality    share of contributing items whose expected counters were present
 *
 * The range is deleted and rewritten in one transaction, so re-running is idempotent.
 */
export async function deriveObservations(db: Db, topicIds: string[], from: Date, collectedAt = new Date()): Promise<number> {
  if (topicIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    await tx.query("DELETE FROM observations WHERE topic_id = ANY($1) AND source = ANY($2) AND observed_at >= $3", [topicIds, ITEM_SOURCES, from]);
    const rows = await tx.query<{ n: number }>(
      `WITH linked AS (
         SELECT l.topic_id, i.id AS item_id, i.provider, i.story_key, i.published_at, i.first_collected_at, i.url, i.is_demo
           FROM topic_source_links l JOIN source_items i ON i.id = l.source_item_id
          WHERE l.topic_id = ANY($1) AND i.provider = ANY($2)
       ),
       snaps AS (
         SELECT s.item_id, s.bucket_at, s.observed_at, s.views, s.likes, s.comments, s.source_rank,
                LAG(s.views) OVER w AS pv, LAG(s.likes) OVER w AS pl, LAG(s.comments) OVER w AS pc,
                ROW_NUMBER() OVER w AS rn
           FROM item_metric_snapshots s
          WHERE s.item_id IN (SELECT item_id FROM linked)
         WINDOW w AS (PARTITION BY s.item_id ORDER BY s.bucket_at)
       ),
       deltas AS (
         SELECT k.topic_id, k.provider, s.bucket_at, s.observed_at, k.item_id, k.url, k.published_at, k.is_demo, s.source_rank,
                CASE WHEN s.rn = 1 THEN CASE WHEN k.published_at >= s.observed_at - make_interval(hours => $5) THEN s.views END
                     ELSE GREATEST(s.views - s.pv, 0) END AS dv,
                CASE WHEN s.rn = 1 THEN CASE WHEN k.published_at >= s.observed_at - make_interval(hours => $5) THEN GREATEST(s.likes, 0) END
                     ELSE GREATEST(s.likes - s.pl, 0) END AS dl,
                CASE WHEN s.rn = 1 THEN CASE WHEN k.published_at >= s.observed_at - make_interval(hours => $5) THEN s.comments END
                     ELSE GREATEST(s.comments - s.pc, 0) END AS dc,
                (s.rn > 1 OR k.published_at >= s.observed_at - make_interval(hours => $5)) AS attributable,
                (CASE k.provider WHEN 'youtube' THEN s.views IS NOT NULL AND s.likes IS NOT NULL AND s.comments IS NOT NULL
                                 WHEN 'demo_youtube' THEN s.views IS NOT NULL AND s.likes IS NOT NULL AND s.comments IS NOT NULL
                                 ELSE s.likes IS NOT NULL AND s.comments IS NOT NULL END) AS complete
           FROM snaps s JOIN linked k ON k.item_id = s.item_id
          WHERE s.bucket_at >= $3
       ),
       posts AS (
         SELECT topic_id, provider, date_trunc('hour', published_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_at,
                item_id, story_key, published_at, first_collected_at, url, is_demo,
                -- A story counts once, in the bucket where its first copy appeared.
                ROW_NUMBER() OVER (PARTITION BY topic_id, provider, story_key ORDER BY published_at, item_id) = 1 AS first_in_story
           FROM linked WHERE published_at IS NOT NULL AND published_at <= $4
       ),
       keys AS (
         SELECT topic_id, provider, bucket_at FROM deltas WHERE attributable
         UNION SELECT topic_id, provider, bucket_at FROM posts WHERE bucket_at >= $3
       ),
       agg AS (
         SELECT k.topic_id, k.provider, k.bucket_at,
                (SELECT COUNT(*) FROM posts p WHERE p.topic_id = k.topic_id AND p.provider = k.provider AND p.bucket_at = k.bucket_at)::int AS new_posts,
                (SELECT COUNT(*) FROM posts p WHERE p.topic_id = k.topic_id AND p.provider = k.provider AND p.bucket_at = k.bucket_at AND p.first_in_story)::int AS unique_stories,
                (SELECT SUM(d.dv) FROM deltas d WHERE d.topic_id = k.topic_id AND d.provider = k.provider AND d.bucket_at = k.bucket_at AND d.attributable) AS new_views,
                (SELECT SUM(d.dl) FROM deltas d WHERE d.topic_id = k.topic_id AND d.provider = k.provider AND d.bucket_at = k.bucket_at AND d.attributable) AS new_likes,
                (SELECT SUM(d.dc) FROM deltas d WHERE d.topic_id = k.topic_id AND d.provider = k.provider AND d.bucket_at = k.bucket_at AND d.attributable) AS new_comments,
                (SELECT MIN(d.source_rank) FROM deltas d WHERE d.topic_id = k.topic_id AND d.provider = k.provider AND d.bucket_at = k.bucket_at) AS source_rank,
                (SELECT COUNT(DISTINCT x.item_id) FROM (
                    SELECT item_id FROM posts p WHERE p.topic_id = k.topic_id AND p.provider = k.provider AND p.bucket_at = k.bucket_at
                    UNION SELECT item_id FROM deltas d WHERE d.topic_id = k.topic_id AND d.provider = k.provider AND d.bucket_at = k.bucket_at AND d.attributable) x)::int AS sample_size,
                (SELECT AVG(CASE WHEN d.complete THEN 1.0 ELSE 0.0 END) FROM deltas d WHERE d.topic_id = k.topic_id AND d.provider = k.provider AND d.bucket_at = k.bucket_at) AS quality,
                (SELECT MAX(p.published_at) FROM posts p WHERE p.topic_id = k.topic_id AND p.provider = k.provider AND p.bucket_at = k.bucket_at) AS published_at,
                -- When the underlying data was actually collected (not when this row was derived):
                -- drives freshness and keeps backtests from seeing data collected after their cutoff.
                GREATEST(
                  (SELECT MAX(d.observed_at) FROM deltas d WHERE d.topic_id = k.topic_id AND d.provider = k.provider AND d.bucket_at = k.bucket_at AND d.attributable),
                  (SELECT MAX(p.first_collected_at) FROM posts p WHERE p.topic_id = k.topic_id AND p.provider = k.provider AND p.bucket_at = k.bucket_at)
                ) AS data_collected_at,
                COALESCE(
                  (SELECT d.url FROM deltas d WHERE d.topic_id = k.topic_id AND d.provider = k.provider AND d.bucket_at = k.bucket_at AND d.attributable ORDER BY d.dv DESC NULLS LAST, d.dc DESC NULLS LAST, d.item_id LIMIT 1),
                  (SELECT p.url FROM posts p WHERE p.topic_id = k.topic_id AND p.provider = k.provider AND p.bucket_at = k.bucket_at ORDER BY p.published_at DESC, p.item_id LIMIT 1)
                ) AS source_url,
                COALESCE((SELECT BOOL_OR(x.is_demo) FROM linked x WHERE x.topic_id = k.topic_id), FALSE) AS is_demo
           FROM keys k
       ),
       ins AS (
         INSERT INTO observations (topic_id, source, observed_at, collected_at, published_at, new_posts, new_views, new_likes, new_comments,
                                   engagement_rate, source_rank, sample_size, unique_stories, data_quality, source_url, is_demo)
         SELECT topic_id, provider, bucket_at, COALESCE(data_collected_at, $4), published_at, new_posts,
                CASE WHEN provider IN ('youtube', 'demo_youtube') THEN new_views END,
                new_likes, new_comments,
                CASE WHEN new_views > 0 THEN (COALESCE(new_likes, 0) + COALESCE(new_comments, 0))::float8 / new_views END,
                source_rank, sample_size, unique_stories, COALESCE(quality, 1), source_url, is_demo
           FROM agg WHERE sample_size > 0
         ON CONFLICT (topic_id, source, observed_at) DO UPDATE SET
           collected_at = EXCLUDED.collected_at, published_at = EXCLUDED.published_at, new_posts = EXCLUDED.new_posts,
           new_views = EXCLUDED.new_views, new_likes = EXCLUDED.new_likes, new_comments = EXCLUDED.new_comments,
           engagement_rate = EXCLUDED.engagement_rate, source_rank = EXCLUDED.source_rank, sample_size = EXCLUDED.sample_size,
           unique_stories = EXCLUDED.unique_stories, data_quality = EXCLUDED.data_quality, source_url = EXCLUDED.source_url
         RETURNING 1
       )
       SELECT COUNT(*)::int8 AS n FROM ins`,
      [topicIds, ITEM_SOURCES, from, collectedAt, FIRST_SNAPSHOT_ATTRIBUTION_HOURS],
    );
    return Number(rows[0]?.n ?? 0);
  });
}
