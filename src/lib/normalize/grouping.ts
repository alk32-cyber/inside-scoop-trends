import { categories, curatedTopics, fallbackCategory, type CuratedTopic } from "../config";
import { canonicalKey, extractCandidates, fingerprintSimilarity, hasContext, jaccard, normalizeText, titleFingerprint, tokenSet, type Candidate } from "./text";

// ---------- curated topics ----------

interface CompiledAlias {
  topic: CuratedTopic;
  key: string;
}

export function compileAliases(topics: CuratedTopic[]): CompiledAlias[] {
  return (
    topics
      .flatMap((topic) => [topic.name, ...topic.aliases].map((a) => ({ topic, key: canonicalKey(a) })))
      .filter((a) => a.key)
      // Longest aliases first so "tiktok shop" wins over a shorter overlapping alias.
      .sort((a, b) => b.key.length - a.key.length)
  );
}

const compiledAliases = compileAliases(curatedTopics);

export interface CuratedMatch {
  topicId: string;
  alias: string;
}

/**
 * Finds curated topics mentioned in a piece of text. Aliases with requireContext
 * only match when a context word is present, which keeps "meta" (the word)
 * from being counted as Meta (the company).
 */
export function matchCurated(text: string, topics: CompiledAlias[] = compiledAliases): CuratedMatch[] {
  const key = ` ${canonicalKey(text)} `;
  const matches = new Map<string, CuratedMatch>();
  const consumed: Array<[number, number]> = [];
  for (const a of topics) {
    if (matches.has(a.topic.id)) continue;
    const idx = key.indexOf(` ${a.key} `);
    if (idx < 0) continue;
    const span: [number, number] = [idx, idx + a.key.length + 2];
    // A shorter alias inside an already-matched longer alias of a different topic is not a separate mention.
    if (consumed.some(([s, e]) => span[0] >= s && span[1] <= e)) continue;
    if (!hasContext(text, a.topic.requireContext)) continue;
    matches.set(a.topic.id, { topicId: a.topic.id, alias: a.key });
    consumed.push(span);
  }
  return [...matches.values()];
}

/** Keys owned by curated topics; extracted candidates with these keys are attributed to the curated topic instead. */
export const curatedKeys: Set<string> = new Set(compiledAliases.map((a) => a.key));

// ---------- candidate support + overlap suppression ----------

export interface ItemForGrouping {
  id: number;
  text: string;
  storyKey: string;
}

export interface CandidateSupport {
  key: string;
  phrase: string;
  kind: Candidate["kind"];
  itemIds: number[];
  storyKeys: Set<string>;
}

/** Counts distinct-story support for every extracted candidate across a batch of items. */
export function candidateSupport(items: ItemForGrouping[]): Map<string, CandidateSupport> {
  const support = new Map<string, CandidateSupport>();
  for (const item of items) {
    // Words inside a curated mention ("shop" in "TikTok Shop") belong to that topic, not a new one.
    const curatedSpans = matchCurated(item.text).map((m) => ` ${m.alias} `);
    for (const c of extractCandidates(item.text)) {
      if (curatedKeys.has(c.key)) continue;
      if (curatedSpans.some((span) => span.includes(` ${c.key} `))) continue;
      let s = support.get(c.key);
      if (!s) {
        s = { key: c.key, phrase: c.phrase, kind: c.kind, itemIds: [], storyKeys: new Set() };
        support.set(c.key, s);
      }
      if (c.kind === "entity") s.kind = "entity";
      s.itemIds.push(item.id);
      s.storyKeys.add(item.storyKey);
    }
  }
  return support;
}

export interface ActivationRules {
  /** Distinct stories needed before an extracted entity phrase becomes a topic. */
  minStoriesEntity: number;
  /** Distinct stories needed for a plain n-gram (more noise-prone). */
  minStoriesNgram: number;
  /** Drop a sub-phrase when a containing phrase covers at least this share of its stories. */
  containmentShare: number;
}

export const defaultActivationRules: ActivationRules = { minStoriesEntity: 2, minStoriesNgram: 3, containmentShare: 0.8 };

/**
 * Chooses which candidates are strong enough to become topics.
 * Overlapping phrases are collapsed: if "vision pro" and "apple vision pro" are
 * supported by the same stories, only the more specific phrase survives; if the
 * shorter phrase has much broader support, both survive as distinct topics.
 */
export function selectTopics(support: Map<string, CandidateSupport>, rules: ActivationRules = defaultActivationRules): CandidateSupport[] {
  const eligible = [...support.values()].filter(
    (s) =>
      s.storyKeys.size >= (s.kind === "entity" ? rules.minStoriesEntity : rules.minStoriesNgram) &&
      // Lowercase single words ("building", "pricing") are too ambiguous to be topics; single-word
      // topics must be proper nouns (entities) or come from the curated list.
      (s.kind === "entity" || s.key.includes(" ")),
  );
  const keep = new Set(eligible.map((s) => s.key));
  for (const short of eligible) {
    for (const long of eligible) {
      if (long.key === short.key || !keep.has(long.key)) continue;
      if (!` ${long.key} `.includes(` ${short.key} `)) continue;
      let shared = 0;
      for (const k of short.storyKeys) if (long.storyKeys.has(k)) shared++;
      if (shared / short.storyKeys.size >= rules.containmentShare) {
        keep.delete(short.key);
        break;
      }
    }
  }
  // Two-token phrases that are subsets of each other's tokens but not contiguous ("shop tiktok") are folded by key order.
  const byTokens = new Map<string, CandidateSupport>();
  for (const s of eligible) {
    if (!keep.has(s.key)) continue;
    const sig = [...tokenSet(s.key)].sort().join(" ");
    const prev = byTokens.get(sig);
    if (!prev || s.storyKeys.size > prev.storyKeys.size) byTokens.set(sig, s);
  }
  return [...byTokens.values()].sort((a, b) => b.storyKeys.size - a.storyKeys.size || a.key.localeCompare(b.key));
}

// ---------- semantic merge guard ----------

export interface MergeCandidate {
  id: string;
  key: string;
  category: string;
}

/**
 * Decides whether two topics are the same subject.
 * - Deterministic path: identical keys, or one key equals the other minus modifiers.
 * - Embedding path: cosine >= threshold, but only within one category and never across a
 *   configured doNotMergeWith pair. Token overlap alone (Apple Vision Pro vs Apple Pay) never merges.
 */
export function shouldMerge(a: MergeCandidate, b: MergeCandidate, cosine: number | null, threshold = 0.9): boolean {
  if (a.id === b.id) return false;
  const blocked = curatedTopics.some((t) => (t.id === a.id && t.doNotMergeWith?.includes(b.id)) || (t.id === b.id && t.doNotMergeWith?.includes(a.id)));
  if (blocked) return false;
  if (a.key === b.key) return true;
  if (cosine === null) return false;
  if (a.category !== b.category) return false;
  // Embeddings rate brand siblings as similar; require real lexical overlap as well.
  const lexical = jaccard(tokenSet(a.key), tokenSet(b.key));
  return cosine >= threshold && lexical >= 0.5;
}

// ---------- category + audience relevance ----------

export interface CategoryAssignment {
  category: string;
  /** Editorial relevance estimate 0-100 (config weights × match strength). Not observed demand. */
  relevance: number;
  matchedKeywords: string[];
}

function keywordHits(text: string, keywords: string[]): string[] {
  const norm = ` ${normalizeText(text)} `;
  return keywords.filter((k) => norm.includes(` ${normalizeText(k)} `));
}

export function assignCategory(name: string, evidenceTitles: string[] = [], preset?: string): CategoryAssignment {
  if (preset) {
    const c = categories.find((x) => x.id === preset);
    if (c) {
      const hits = keywordHits(name, c.keywords);
      return { category: c.id, relevance: Math.round(100 * c.weight), matchedKeywords: hits };
    }
  }
  let best: { id: string; weight: number; strength: number; hits: string[] } | null = null;
  for (const c of categories) {
    const nameHits = keywordHits(name, c.keywords);
    const evidenceShare = evidenceTitles.length ? evidenceTitles.filter((t) => keywordHits(t, c.keywords).length > 0).length / evidenceTitles.length : 0;
    // Name match is strong evidence; otherwise rely on how much of the evidence sits in the category.
    const strength = nameHits.length ? 1 : evidenceShare >= 0.3 ? 0.5 + 0.5 * evidenceShare : 0;
    if (strength === 0) continue;
    const value = strength * c.weight;
    if (!best || value > best.strength * best.weight) best = { id: c.id, weight: c.weight, strength, hits: nameHits };
  }
  if (!best) return { category: fallbackCategory.id, relevance: Math.round(100 * fallbackCategory.weight), matchedKeywords: [] };
  return { category: best.id, relevance: Math.round(100 * best.weight * best.strength), matchedKeywords: best.hits };
}

// ---------- story dedupe ----------

export interface StoryRef {
  storyKey: string;
  fingerprint: string;
}

/**
 * Assigns a story key: explicit outbound URL wins (a Reddit link post and the news
 * article it links are one story); otherwise a near-identical headline seen
 * recently is treated as the same story (syndication / reposts).
 */
export function assignStoryKey(params: { defaultKey: string; title: string; linkedUrl?: string | null; recent: StoryRef[]; similarity?: number }): {
  storyKey: string;
  fingerprint: string;
} {
  const fingerprint = titleFingerprint(params.title);
  if (params.linkedUrl) return { storyKey: `url:${params.linkedUrl}`, fingerprint };
  const tokens = fingerprint.split(" ").filter(Boolean).length;
  if (tokens >= 4) {
    for (const r of params.recent) {
      if (fingerprintSimilarity(fingerprint, r.fingerprint) >= (params.similarity ?? 0.8)) return { storyKey: r.storyKey, fingerprint };
    }
  }
  return { storyKey: params.defaultKey, fingerprint };
}
