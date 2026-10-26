import teenJson from "../../config/teen.json";
import { normalizeText } from "./normalize/text";

/**
 * "Pod Score": how good a topic is for a teen business podcast right now.
 * Pure functions only, so the ranking is deterministic and testable.
 *
 *   pod = 0.40 · teen appeal + 0.25 · coverage + 0.20 · buzz + 0.15 · freshness
 *
 *  teen appeal  does it touch things teens care about (creators, gaming, money, apps, brands...)
 *  coverage     how many different stories/outlets are talking about it
 *  buzz         the measured trend score (growth over its own baseline)
 *  freshness    how recent the newest story is
 * Heavy news (war, lawsuits, politics...) is pushed down and labelled, never hidden.
 */

export interface Lane {
  id: string;
  label: string;
  emoji: string;
}

interface LaneDef extends Lane {
  weight: number;
  keywords: string[];
}

const LANES: LaneDef[] = Object.entries(teenJson.lanes).map(([id, l]) => ({ id, ...l }));
const HEAVY = teenJson.heavy.map((w) => normalizeText(w));
const VAGUE = new Set(teenJson.vague.map((w) => normalizeText(w)));
export const OTHER_LANE: Lane = { id: "other", label: "Other business", emoji: "📰" };
export const LANES_PUBLIC: Lane[] = [...LANES.map(({ id, label, emoji }) => ({ id, label, emoji })), OTHER_LANE];

function hits(text: string, words: string[]): number {
  const t = ` ${normalizeText(text)} `;
  let n = 0;
  for (const w of words) if (t.includes(` ${normalizeText(w)} `)) n++;
  return n;
}

export interface Headline {
  title: string;
  url: string;
  outlet: string | null;
  publishedAt: string | null;
}

export interface Appeal {
  lane: Lane;
  /** 0-100 */
  appeal: number;
  heavy: boolean;
  vague: boolean;
}

/** Picks the lane a topic belongs to and how teen-relevant it is, from its name and headlines. */
export function teenAppeal(name: string, headlines: string[]): Appeal {
  let best: { lane: LaneDef; strength: number } | null = null;
  for (const lane of LANES) {
    const nameHit = hits(name, lane.keywords) > 0;
    const share = headlines.length ? headlines.filter((h) => hits(h, lane.keywords) > 0).length / headlines.length : 0;
    // The topic's own name is the strongest signal; otherwise how much of its coverage sits in the lane.
    const strength = nameHit ? 1 : share > 0 ? 0.35 + 0.55 * share : 0;
    if (strength > 0 && (!best || strength * lane.weight > best.strength * best.lane.weight)) best = { lane, strength };
  }
  const key = normalizeText(name);
  const vague = !key.includes(" ") && VAGUE.has(key);
  const heavyShare = headlines.length ? headlines.filter((h) => hits(h, HEAVY) > 0).length / headlines.length : hits(name, HEAVY) > 0 ? 1 : 0;
  const heavy = heavyShare >= 0.5;

  let appeal = best ? 100 * best.lane.weight * best.strength : 15;
  if (vague) appeal *= 0.5;
  if (heavy) appeal *= 0.45;
  const lane = best ? { id: best.lane.id, label: best.lane.label, emoji: best.lane.emoji } : OTHER_LANE;
  return { lane, appeal: Math.round(appeal), heavy, vague };
}

/** 1 story → 20, 2 → 45, 3 → 60, 5 → 80, 8+ → 100 (distinct stories, syndicated copies counted once). */
export function coverageScore(stories: number, outlets: number): number {
  if (stories <= 0) return 0;
  const base = Math.min(100, 20 + 80 * (Math.log(stories) / Math.log(8)));
  const outletBonus = Math.min(10, Math.max(0, outlets - 1) * 3);
  return Math.round(Math.min(100, base + outletBonus));
}

export function freshnessScore(newestIso: string | null, now = Date.now()): number {
  if (!newestIso) return 0;
  const h = (now - Date.parse(newestIso)) / 3600_000;
  if (h <= 24) return 100;
  if (h <= 48) return 70;
  if (h <= 72) return 40;
  return 10;
}

export type PodTier = "hot" | "solid" | "maybe" | "skip";

export const TIERS: Record<PodTier, { label: string; emoji: string; blurb: string }> = {
  hot: { label: "Talk about this", emoji: "🔥", blurb: "Strong pick for this week's episode" },
  solid: { label: "Solid pick", emoji: "👍", blurb: "Good topic, worth a segment" },
  maybe: { label: "Maybe", emoji: "😐", blurb: "Could work with the right angle" },
  skip: { label: "Skip for now", emoji: "🥶", blurb: "Not enough buzz or not a great fit" },
};

export function tierFor(score: number): PodTier {
  return score >= 70 ? "hot" : score >= 55 ? "solid" : score >= 40 ? "maybe" : "skip";
}

export interface PodInput {
  name: string;
  headlines: Headline[];
  stories: number;
  outlets: number;
  trendScore: number;
  lifecycle: string;
  newestAt: string | null;
}

export interface PodResult extends Appeal {
  podScore: number;
  tier: PodTier;
  coverage: number;
  freshness: number;
  reasons: string[];
  starters: string[];
}

export function podScore(input: PodInput, now = Date.now()): PodResult {
  const appeal = teenAppeal(
    input.name,
    input.headlines.map((h) => h.title),
  );
  const coverage = coverageScore(input.stories, input.outlets);
  const freshness = freshnessScore(input.newestAt, now);
  let score = 0.4 * appeal.appeal + 0.25 * coverage + 0.2 * input.trendScore + 0.15 * freshness;
  // One story is a headline, not a topic: never rank it above "maybe".
  if (input.stories < 2) score = Math.min(score, 45);
  score = Math.round(Math.max(0, Math.min(100, score)));
  return {
    ...appeal,
    podScore: score,
    tier: tierFor(score),
    coverage,
    freshness,
    reasons: reasons(input, appeal, coverage),
    starters: starters(input.name, appeal.lane.id),
  };
}

function reasons(input: PodInput, appeal: Appeal, coverage: number): string[] {
  const out: string[] = [];
  if (appeal.lane.id !== "other" && appeal.appeal >= 50) out.push(`${appeal.lane.emoji} ${appeal.lane.label}: stuff teens actually follow`);
  if (input.outlets >= 3) out.push(`📰 ${input.outlets} different outlets are covering it`);
  else if (input.stories >= 2) out.push(`📰 ${input.stories} separate stories so far`);
  if (["breakout", "rising", "emerging"].includes(input.lifecycle)) out.push(input.lifecycle === "breakout" ? "🚀 Blowing up right now" : "📈 Picking up fast");
  if (input.newestAt && Date.now() - Date.parse(input.newestAt) < 24 * 3600_000) out.push("🆕 New in the last 24 hours");
  if (appeal.heavy) out.push("⚠️ Heavy news: handle with care or skip");
  if (appeal.vague) out.push("🤏 A bit vague on its own: pick one specific story");
  if (coverage <= 20 && !appeal.heavy) out.push("🔎 Only one story so far: might be too early");
  return out;
}

const STARTERS: Record<string, string[]> = {
  creators: [
    "How does the money actually work behind {T}?",
    "Would you want to do this full-time? What's the catch?",
    "Is this good or bad news for small creators?",
  ],
  gaming: [
    "Who's really making the money here: the game company, the players, or the streamers?",
    "Would you pay for this? How much is too much?",
    "Could someone our age build a business around {T}?",
  ],
  money: [
    "What would you do with this if you were 16?",
    "Smart move or a trap? Why?",
    "What do adults get wrong about {T}?",
  ],
  tech: [
    "Would you actually use or trust {T}?",
    "Does this create opportunities for our generation, or take them away?",
    "What app or side business could someone build on top of this?",
  ],
  brands: [
    "Why do people our age care about {T}?",
    "Would you buy it? What's the business trick behind the hype?",
    "If you ran {T}, what would you do next?",
  ],
  entertainment: [
    "Who's really getting paid here?",
    "Is {T} a business lesson in disguise? What's the lesson?",
    "How would you market this to people our age?",
  ],
  startups: [
    "Would you work at, invest in, or compete with {T}?",
    "What's the one lesson a teen founder can steal from this?",
    "Is this hype or the real deal? Defend your answer.",
  ],
  other: [
    "Explain {T} in one sentence: why should a teenager care?",
    "Who wins and who loses from this?",
    "What business idea does this give you?",
  ],
};

/**
 * How a topic name reads mid-sentence: sentence-case phrases ("Salary negotiation") are lowered,
 * names and brands ("TikTok Shop", "AI agents", "MrBeast") keep their capitals.
 */
export function inSentence(name: string): string {
  const words = name.split(" ");
  const sentenceCase = words.length > 1 && /^[A-Z][a-z]/.test(words[0]) && words.slice(1).every((w) => w === w.toLowerCase());
  return sentenceCase ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

export function starters(name: string, laneId: string): string[] {
  const t = inSentence(name);
  return (STARTERS[laneId] ?? STARTERS.other).map((s) => {
    const out = s.replace(/\{T\}/g, t);
    return out.charAt(0).toUpperCase() + out.slice(1);
  });
}

/**
 * Removes topics that are really the same story as a better-ranked topic ("Anthropic", "Anthropic IPO", "IPO").
 * Input must already be sorted best first; a topic is dropped when most of its headlines are already covered.
 */
export function dropOverlapping<T extends { headlines: { url: string }[] }>(sortedBest: T[], maxShared = 0.6): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of sortedBest) {
    const urls = t.headlines.map((h) => h.url);
    const shared = urls.filter((u) => seen.has(u)).length;
    if (urls.length > 0 && shared / urls.length >= maxShared) continue;
    urls.forEach((u) => seen.add(u));
    out.push(t);
  }
  return out;
}
