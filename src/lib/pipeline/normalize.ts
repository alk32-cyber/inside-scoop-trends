import type { Db } from "../db";
import { curatedTopics } from "../config";
import { assignCategory, candidateSupport, matchCurated, selectTopics, shouldMerge, type ItemForGrouping } from "../normalize/grouping";
import { canonicalKey, slugify, surfaceForm } from "../normalize/text";
import { embedTexts, embeddingsConfigured } from "../normalize/embeddings";

const LOOKBACK_DAYS = 7;

/** Id of a curated topic in the live or demo namespace. Demo data never touches live topics. */
export function curatedTopicId(id: string, isDemo: boolean): string {
  return isDemo ? `demo-${id}` : id;
}

/** Inserts curated topics from config/topics.json (idempotent). */
export async function ensureCuratedTopics(db: Db, isDemo = false): Promise<void> {
  for (const t of curatedTopics) {
    if (isDemo) {
      // Demo copies need no alias rows: curated matching runs from config, not the alias table.
      await db.query(
        `INSERT INTO topics (id, canonical_key, name, category, status, origin, is_demo) VALUES ($1, $2, $3, $4, 'candidate', 'demo', TRUE)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category`,
        [curatedTopicId(t.id, true), `demo-config:${t.id}`, t.name, t.category],
      );
      continue;
    }
    await db.query(
      `INSERT INTO topics (id, canonical_key, name, category, status, origin) VALUES ($1, $2, $3, $4, 'candidate', 'config')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category`,
      [t.id, `config:${t.id}`, t.name, t.category],
    );
    for (const alias of [t.name, ...t.aliases]) {
      await db.query(
        `INSERT INTO topic_aliases (topic_id, alias, alias_key, origin) VALUES ($1, $2, $3, 'config')
         ON CONFLICT (alias_key) DO UPDATE SET topic_id = EXCLUDED.topic_id, origin = 'config'`,
        [t.id, alias, canonicalKey(alias)],
      );
    }
  }
}

interface ItemRow {
  id: number;
  title: string;
  snippet: string | null;
  story_key: string;
  published_at: Date | null;
  first_collected_at: Date;
}

async function uniqueTopicId(db: Db, base: string): Promise<string> {
  let id = base;
  for (let i = 2; ; i++) {
    const [row] = await db.query("SELECT 1 FROM topics WHERE id = $1", [id]);
    if (!row) return id;
    id = `${base}-${i}`;
  }
}

export interface NormalizeResult {
  itemsScanned: number;
  linksCreated: number;
  topicsCreated: string[];
  topicsActivated: number;
  merges: Array<{ from: string; into: string }>;
  touchedTopicIds: string[];
}

/**
 * Maps recent source items to canonical topics.
 *  1. Curated topics match by alias, with context rules for ambiguous names.
 *  2. Extracted phrases with enough distinct-story support become topics.
 *  3. Existing aliases (including merged ones) route phrases to their canonical topic.
 * Live and demo data are normalized separately and never share topics.
 */
export async function normalizeRecent(db: Db, opts: { now?: Date; isDemo?: boolean } = {}): Promise<NormalizeResult> {
  const now = opts.now ?? new Date();
  const isDemo = opts.isDemo ?? false;
  await ensureCuratedTopics(db, isDemo);

  const items = await db.query<ItemRow>(
    `SELECT id, title, snippet, story_key, published_at, first_collected_at FROM source_items
      WHERE is_demo = $1 AND COALESCE(published_at, first_collected_at) > $2`,
    [isDemo, new Date(now.getTime() - LOOKBACK_DAYS * 86400_000)],
  );
  const result: NormalizeResult = { itemsScanned: items.length, linksCreated: 0, topicsCreated: [], topicsActivated: 0, merges: [], touchedTopicIds: [] };
  if (items.length === 0) return result;

  const touched = new Set<string>();
  const link = async (topicId: string, itemId: number, method: string, text: string) => {
    const rows = await db.query(
      `INSERT INTO topic_source_links (topic_id, source_item_id, match_method, matched_text) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING topic_id`,
      [topicId, itemId, method, text],
    );
    if (rows.length) {
      result.linksCreated++;
      touched.add(topicId);
    }
  };

  // 1. curated topics
  for (const it of items) {
    for (const m of matchCurated(`${it.title}. ${it.snippet ?? ""}`)) await link(curatedTopicId(m.topicId, isDemo), it.id, "config", m.alias);
  }

  // 2 + 3. extracted topics (titles only: descriptions are noisier and often boilerplate)
  const grouping: ItemForGrouping[] = items.map((it) => ({ id: it.id, text: it.title, storyKey: it.story_key }));
  const support = candidateSupport(grouping);
  const selected = selectTopics(support);
  const titleById = new Map(items.map((it) => [it.id, it.title]));

  const aliasRows = await db.query<{ alias_key: string; topic_id: string; status: string; is_demo: boolean }>(
    `SELECT a.alias_key, COALESCE(t2.id, t.id) AS topic_id, COALESCE(t2.status, t.status) AS status, t.is_demo
       FROM topic_aliases a JOIN topics t ON t.id = a.topic_id LEFT JOIN topics t2 ON t2.id = t.merged_into
      WHERE a.alias_key = ANY($1)`,
    [selected.map((s) => s.key)],
  );
  const aliasMap = new Map(aliasRows.filter((r) => r.is_demo === isDemo).map((r) => [r.alias_key, r.topic_id]));

  for (const s of selected) {
    let topicId = aliasMap.get(s.key);
    if (!topicId) {
      const titles = s.itemIds.map((id) => titleById.get(id) ?? "");
      const { category } = assignCategory(s.phrase, titles);
      topicId = await uniqueTopicId(db, (isDemo ? "demo-" : "") + slugify(s.key));
      const display = surfaceForm(s.phrase, titles);
      await db.query(
        `INSERT INTO topics (id, canonical_key, name, category, status, origin, is_demo, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 'candidate', $5, $6, $7, $7) ON CONFLICT (canonical_key) DO NOTHING`,
        [topicId, `${isDemo ? "demo:" : ""}${s.key}`, display, category, isDemo ? "demo" : "extracted", isDemo, now],
      );
      const [row] = await db.query<{ id: string }>("SELECT id FROM topics WHERE canonical_key = $1", [`${isDemo ? "demo:" : ""}${s.key}`]);
      topicId = row.id;
      await db.query(`INSERT INTO topic_aliases (topic_id, alias, alias_key, origin) VALUES ($1, $2, $3, $4) ON CONFLICT (alias_key) DO NOTHING`, [
        topicId,
        s.phrase,
        s.key,
        isDemo ? "demo" : "extracted",
      ]);
      result.topicsCreated.push(topicId);
    }
    for (const itemId of s.itemIds) await link(topicId, itemId, "extracted", s.phrase);
  }

  // Activate topics with recent evidence; record when they were last seen.
  const activated = await db.query(
    `UPDATE topics t SET status = 'active', updated_at = $1,
        last_seen_at = GREATEST(t.last_seen_at, (SELECT MAX(COALESCE(i.published_at, i.first_collected_at)) FROM topic_source_links l JOIN source_items i ON i.id = l.source_item_id WHERE l.topic_id = t.id)),
        first_seen_at = LEAST(t.first_seen_at, (SELECT MIN(COALESCE(i.published_at, i.first_collected_at)) FROM topic_source_links l JOIN source_items i ON i.id = l.source_item_id WHERE l.topic_id = t.id))
      WHERE t.status IN ('candidate', 'active') AND t.is_demo = $2
        AND EXISTS (SELECT 1 FROM topic_source_links l JOIN source_items i ON i.id = l.source_item_id
                     WHERE l.topic_id = t.id AND i.is_demo = $2 AND COALESCE(i.published_at, i.first_collected_at) > $3)
      RETURNING t.id`,
    [now, isDemo, new Date(now.getTime() - LOOKBACK_DAYS * 86400_000)],
  );
  result.topicsActivated = activated.length;

  if (embeddingsConfigured()) result.merges = await semanticMerge(db, isDemo);
  for (const m of result.merges) touched.add(m.into);

  await db.query("UPDATE source_items SET normalized_at = $1 WHERE is_demo = $2 AND normalized_at IS NULL", [now, isDemo]);
  result.touchedTopicIds = [...touched];
  return result;
}

/** Merges near-duplicate extracted topics using embeddings, guarded by shouldMerge(). */
async function semanticMerge(db: Db, isDemo: boolean): Promise<Array<{ from: string; into: string }>> {
  const topics = await db.query<{ id: string; canonical_key: string; name: string; category: string; embedding: number[] | null; origin: string; links: number }>(
    `SELECT t.id, t.canonical_key, t.name, t.category, t.embedding, t.origin, (SELECT COUNT(*)::int8 FROM topic_source_links l WHERE l.topic_id = t.id) AS links
       FROM topics t WHERE t.status = 'active' AND t.is_demo = $1`,
    [isDemo],
  );
  const needs = topics.filter((t) => !t.embedding);
  if (needs.length) {
    const vectors = await embedTexts(needs.map((t) => t.name));
    for (let i = 0; i < needs.length; i++) {
      needs[i].embedding = vectors[i];
      await db.query("UPDATE topics SET embedding = $2 WHERE id = $1", [needs[i].id, JSON.stringify(vectors[i])]);
    }
  }
  const cos = (a: number[], b: number[]) => {
    let d = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      d += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  };
  const merges: Array<{ from: string; into: string }> = [];
  const gone = new Set<string>();
  // Curated topics and better-supported topics survive; ordering is deterministic.
  const ordered = [...topics].sort((a, b) => Number(b.origin === "config") - Number(a.origin === "config") || b.links - a.links || a.id.localeCompare(b.id));
  for (let i = 0; i < ordered.length; i++) {
    const keep = ordered[i];
    if (gone.has(keep.id)) continue;
    for (let j = i + 1; j < ordered.length; j++) {
      const drop = ordered[j];
      if (gone.has(drop.id) || drop.origin === "config" || !keep.embedding || !drop.embedding) continue;
      const a = { id: keep.id.replace(/^demo-/, ""), key: keep.canonical_key.replace(/^(demo-config|demo|config):/, ""), category: keep.category };
      const b = { id: drop.id.replace(/^demo-/, ""), key: drop.canonical_key.replace(/^(demo-config|demo|config):/, ""), category: drop.category };
      if (!shouldMerge(a, b, cos(keep.embedding, drop.embedding))) continue;
      await db.transaction(async (tx) => {
        await tx.query("UPDATE topic_aliases SET topic_id = $1, origin = 'merge' WHERE topic_id = $2", [keep.id, drop.id]);
        await tx.query(
          `INSERT INTO topic_source_links (topic_id, source_item_id, match_method, matched_text)
             SELECT $1, source_item_id, 'embedding', matched_text FROM topic_source_links WHERE topic_id = $2 ON CONFLICT DO NOTHING`,
          [keep.id, drop.id],
        );
        await tx.query("DELETE FROM topic_source_links WHERE topic_id = $1", [drop.id]);
        await tx.query("DELETE FROM observations WHERE topic_id = $1", [drop.id]);
        await tx.query("DELETE FROM trend_scores WHERE topic_id = $1", [drop.id]);
        await tx.query("UPDATE topics SET status = 'merged', merged_into = $1, updated_at = now() WHERE id = $2", [keep.id, drop.id]);
      });
      gone.add(drop.id);
      merges.push({ from: drop.id, into: keep.id });
    }
  }
  return merges;
}
