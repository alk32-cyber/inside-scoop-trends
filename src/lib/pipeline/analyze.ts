import type { Db } from "../db";
import { generateAnalysis, type EvidenceItem } from "../analysis/generate";
import type { ScoreResult } from "../scoring/score";

/** Loads the evidence behind a topic: most recent and most engaged linked items, one per story. */
export async function loadEvidence(db: Db, topicId: string, limit = 12): Promise<EvidenceItem[]> {
  const rows = await db.query<{
    id: number;
    provider: string;
    title: string;
    snippet: string | null;
    url: string;
    author: string | null;
    published_at: Date | null;
    latest_views: number | null;
    latest_likes: number | null;
    latest_comments: number | null;
  }>(
    `SELECT DISTINCT ON (i.story_key) i.id, i.provider, i.title, i.snippet, i.url, i.author, i.published_at, i.latest_views, i.latest_likes, i.latest_comments
       FROM topic_source_links l JOIN source_items i ON i.id = l.source_item_id
      WHERE l.topic_id = $1 AND i.title NOT LIKE '[removed%'
      ORDER BY i.story_key, COALESCE(i.latest_views, 0) + COALESCE(i.latest_comments, 0) * 20 DESC, i.published_at DESC NULLS LAST`,
    [topicId],
  );
  return rows
    .map((r) => ({
      id: r.id,
      provider: r.provider,
      title: r.title,
      snippet: r.snippet,
      url: r.url,
      author: r.author,
      publishedAt: r.published_at ? new Date(r.published_at) : null,
      views: r.latest_views,
      likes: r.latest_likes,
      comments: r.latest_comments,
    }))
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) || a.id - b.id)
    .slice(0, limit);
}

/**
 * Generates analyses for the top-ranked topics whose data changed since their last
 * analysis. Each analysis is pinned to the newest observation it used (data_timestamp).
 */
export async function analyzeTop(db: Db, results: ScoreResult[], opts: { isDemo?: boolean; limit?: number; env?: Record<string, string | undefined> } = {}): Promise<{ generated: number; skipped: number }> {
  const isDemo = opts.isDemo ?? false;
  let generated = 0;
  let skipped = 0;
  for (const r of results.slice(0, opts.limit ?? 15)) {
    const [topic] = await db.query<{ name: string; category: string }>("SELECT name, category FROM topics WHERE id = $1", [r.topicId]);
    const [ts] = await db.query<{ t: Date | null }>("SELECT MAX(collected_at) AS t FROM observations WHERE topic_id = $1", [r.topicId]);
    if (!topic || !ts?.t) {
      skipped++;
      continue;
    }
    const dataTimestamp = new Date(ts.t);
    const [existing] = await db.query("SELECT 1 FROM content_recommendations WHERE topic_id = $1 AND data_timestamp >= $2", [r.topicId, dataTimestamp]);
    if (existing) {
      skipped++;
      continue;
    }
    const evidence = await loadEvidence(db, r.topicId);
    const analysis = await generateAnalysis({ topicId: r.topicId, name: topic.name, category: topic.category, score: r, evidence, dataTimestamp, isDemo }, opts.env);
    await db.query(
      `INSERT INTO content_recommendations (topic_id, generated_at, data_timestamp, method, model, evidence_sufficient, evidence_item_ids, payload, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (topic_id, data_timestamp, method) DO UPDATE SET generated_at = EXCLUDED.generated_at, payload = EXCLUDED.payload,
         model = EXCLUDED.model, evidence_sufficient = EXCLUDED.evidence_sufficient, evidence_item_ids = EXCLUDED.evidence_item_ids`,
      [r.topicId, new Date(analysis.generated_at), dataTimestamp, analysis.method, analysis.model, analysis.evidence_sufficient, evidence.map((e) => e.id), JSON.stringify(analysis), isDemo],
    );
    generated++;
  }
  return { generated, skipped };
}
