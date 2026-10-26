import categoriesJson from "../../config/categories.json";
import topicsJson from "../../config/topics.json";
import sourcesJson from "../../config/sources.json";

export type ComponentName = "velocity" | "engagement" | "crossPlatform" | "attention" | "relevance";

export type SourceName = "youtube" | "reddit" | "news" | "google_trends" | "demo_youtube" | "demo_reddit" | "demo_news" | "demo_google_trends";

/** Which observation metric represents "how much attention" for each source. */
export type VolumeMetric = "new_views" | "discussion" | "new_posts" | "search_interest";

export interface SourceProfile {
  /** Metric used for velocity and attention. */
  volumeMetric: VolumeMetric;
  /** Whether likes/comments are meaningful for engagement momentum. */
  hasEngagement: boolean;
  /**
   * Pseudo-count added to both sides of a growth ratio. Stops tiny
   * denominators (1 -> 4 posts) from producing huge breakout scores.
   */
  smoothing: number;
  /** Pseudo-count for interaction (likes + comments) growth ratios. */
  engagementSmoothing: number;
  /** Minimum items (or data points) across recent + baseline windows before velocity is trusted. */
  minSample: number;
  /** Observations older than this are stale for this source. */
  staleAfterHours: number;
  /** Relative trust of the source when combining per-source components. */
  reliability: number;
  /** Treated as one independent "platform" for cross-platform confirmation. */
  platform: string;
}

const baseProfiles: Record<string, SourceProfile> = {
  youtube: { volumeMetric: "new_views", hasEngagement: true, smoothing: 2000, engagementSmoothing: 100, minSample: 3, staleAfterHours: 12, reliability: 1, platform: "youtube" },
  reddit: { volumeMetric: "discussion", hasEngagement: true, smoothing: 15, engagementSmoothing: 25, minSample: 3, staleAfterHours: 6, reliability: 0.9, platform: "reddit" },
  news: { volumeMetric: "new_posts", hasEngagement: false, smoothing: 2, engagementSmoothing: 0, minSample: 3, staleAfterHours: 12, reliability: 0.9, platform: "news" },
  google_trends: { volumeMetric: "search_interest", hasEngagement: false, smoothing: 5, engagementSmoothing: 0, minSample: 6, staleAfterHours: 24, reliability: 1, platform: "google_trends" },
};

export const sourceProfiles: Record<string, SourceProfile> = {
  ...baseProfiles,
  // Demo sources mirror real profiles but are kept distinct so they can never be mistaken for live data.
  demo_youtube: { ...baseProfiles.youtube, platform: "demo_youtube" },
  demo_reddit: { ...baseProfiles.reddit, platform: "demo_reddit" },
  demo_news: { ...baseProfiles.news, platform: "demo_news" },
  demo_google_trends: { ...baseProfiles.google_trends, platform: "demo_google_trends" },
};

export function sourceProfile(source: string): SourceProfile {
  const p = sourceProfiles[source];
  if (!p) throw new Error(`Unknown source "${source}"`);
  return p;
}

export interface ScoringConfig {
  weights: Record<ComponentName, number>;
  /** Length of the recent window, and of each equivalent baseline window. */
  windowHours: number;
  /** Number of earlier windows that form the topic's own baseline. */
  baselineWindows: number;
  /** tanh scale for log growth: ln(4) means 4x growth maps to ~88/100. */
  growthScale: number;
  /** Log growth above which a source counts as "growing" for cross-platform confirmation. */
  growingThreshold: number;
  /** Windows with data required before a lifecycle other than insufficient_data is assigned. */
  minLifecycleWindows: number;
  confidenceWeights: { sources: number; sample: number; freshness: number; consistency: number; completeness: number };
  /** Topics at or above this score with confidence below lowConfidence are flagged. */
  highScore: number;
  lowConfidence: number;
  /** Share of total weight that must be measured before missing components are fully reweighted. */
  minCoverage: number;
}

export const defaultScoringConfig: ScoringConfig = {
  weights: { velocity: 0.3, engagement: 0.25, crossPlatform: 0.2, attention: 0.15, relevance: 0.1 },
  windowHours: 24,
  baselineWindows: 6,
  growthScale: Math.log(4),
  growingThreshold: Math.log(1.25),
  minLifecycleWindows: 3,
  confidenceWeights: { sources: 0.25, sample: 0.2, freshness: 0.2, consistency: 0.15, completeness: 0.2 },
  highScore: 60,
  lowConfidence: 40,
  minCoverage: 0.55,
};

/** Reads SCORING_WEIGHTS (JSON) / SCORING_WINDOW_HOURS overrides. Weights are renormalized to sum to 1. */
export function loadScoringConfig(env: Record<string, string | undefined> = process.env): ScoringConfig {
  const cfg: ScoringConfig = structuredClone(defaultScoringConfig);
  if (env.SCORING_WEIGHTS) {
    const parsed = JSON.parse(env.SCORING_WEIGHTS) as Partial<Record<ComponentName, number>>;
    for (const [k, v] of Object.entries(parsed)) {
      if (k in cfg.weights && typeof v === "number" && v >= 0) cfg.weights[k as ComponentName] = v;
    }
  }
  const total = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("SCORING_WEIGHTS must contain at least one positive weight");
  for (const k of Object.keys(cfg.weights) as ComponentName[]) cfg.weights[k] /= total;
  if (env.SCORING_WINDOW_HOURS) cfg.windowHours = Math.max(1, Number(env.SCORING_WINDOW_HOURS));
  return cfg;
}

export interface CategoryDef {
  id: string;
  label: string;
  weight: number;
  keywords: string[];
}

export const categories: CategoryDef[] = Object.entries(categoriesJson.categories).map(([id, c]) => ({ id, ...c }));
export const fallbackCategory = { id: "other", ...categoriesJson.fallback };

export interface CuratedTopic {
  id: string;
  name: string;
  category: string;
  aliases: string[];
  requireContext?: string[];
  doNotMergeWith?: string[];
}

export const curatedTopics: CuratedTopic[] = topicsJson.topics;
export const sourcesConfig = sourcesJson;

/** Per-provider collection schedule (minutes) and daily request budgets. */
export interface ProviderSchedule {
  intervalMinutes: number;
  dailyRequestBudget: number;
}

export function providerSchedule(provider: string, env: Record<string, string | undefined> = process.env): ProviderSchedule {
  const defaults: Record<string, ProviderSchedule> = {
    // YouTube search.list costs 100 quota units; 8 queries every 3h ≈ 6,400 units/day of the 10,000 default.
    youtube: { intervalMinutes: 180, dailyRequestBudget: 90 },
    reddit: { intervalMinutes: 30, dailyRequestBudget: 1500 },
    // NewsAPI developer plan: 100 requests/day.
    news: { intervalMinutes: 120, dailyRequestBudget: 90 },
    // SerpApi: budget depends on plan; 10 topics every 6h = 40 searches/day.
    google_trends: { intervalMinutes: 360, dailyRequestBudget: 40 },
  };
  const d = defaults[provider] ?? { intervalMinutes: 60, dailyRequestBudget: 100 };
  const key = provider.toUpperCase();
  return {
    intervalMinutes: Number(env[`${key}_INTERVAL_MINUTES`] ?? d.intervalMinutes),
    dailyRequestBudget: Number(env[`${key}_DAILY_REQUEST_BUDGET`] ?? d.dailyRequestBudget),
  };
}

/** Observation bucket size. Hourly buckets keep windows aligned across sources. */
export const BUCKET_MS = 60 * 60 * 1000;

export function floorToBucket(d: Date): Date {
  return new Date(Math.floor(d.getTime() / BUCKET_MS) * BUCKET_MS);
}
