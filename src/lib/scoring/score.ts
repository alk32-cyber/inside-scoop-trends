import { defaultScoringConfig, sourceProfile, type ComponentName, type ScoringConfig, type SourceProfile } from "../config";

/**
 * Trend scoring engine. Pure functions only: given observations and an as-of
 * time, the output is fully deterministic, which is what makes live scoring,
 * tests and backtests use exactly the same maths.
 */

export interface ObservationInput {
  source: string;
  observedAt: Date | number;
  collectedAt?: Date | number;
  searchInterest?: number | null;
  newPosts?: number | null;
  newViews?: number | null;
  newLikes?: number | null;
  newComments?: number | null;
  sampleSize?: number | null;
  uniqueStories?: number | null;
  dataQuality?: number | null;
}

export interface TopicInput {
  topicId: string;
  /** Editorial audience-relevance estimate 0-100, or null when not assessed. */
  relevance: number | null;
  observations: ObservationInput[];
  /** Distinct story keys per source in the recent window, used to deduplicate cross-platform evidence. */
  recentStories?: Record<string, string[]>;
  firstSeenAt?: Date | number;
}

/**
 * Whether a provider successfully collected during each window (index 0 = recent).
 * A covered window with no observation row is a measured zero; an uncovered window is missing data.
 * Sources without an entry treat windows without rows as missing.
 */
export type Coverage = Record<string, boolean[]>;

export interface Population {
  /** Recent-window volume of every scored topic, per source, for source-specific attention normalization. */
  recentVolumes: Record<string, number[]>;
}

export type Lifecycle = "emerging" | "rising" | "breakout" | "peaking" | "cooling" | "dormant" | "stable" | "insufficient_data";

export interface SourceBreakdown {
  source: string;
  platform: string;
  windows: Array<number | null>;
  recent: number | null;
  baseline: number | null;
  baselineWindows: number;
  sample: number;
  logGrowth: number | null;
  pctGrowth: number | null;
  zScore: number | null;
  acceleration: number | null;
  velocity: number | null;
  velocityUnavailableReason?: string;
  engagement: number | null;
  engagementUnavailableReason?: string;
  interactionsPerHourRecent: number | null;
  interactionsPerHourBaseline: number | null;
  engagementRateRecent: number | null;
  engagementRateBaseline: number | null;
  attentionPercentile: number | null;
  growing: boolean;
  independent: boolean;
  newestCollectedAt: number | null;
  freshness: number | null;
  avgDataQuality: number | null;
}

export interface ScoreResult {
  topicId: string;
  asOf: number;
  trendScore: number;
  components: Record<ComponentName, number | null>;
  /** Attention before the stagnation damping is applied. */
  attentionRaw: number | null;
  missingComponents: ComponentName[];
  coverage: number;
  confidence: number;
  confidenceParts: { sources: number; sample: number; freshness: number; consistency: number; completeness: number };
  lifecycle: Lifecycle;
  lifecycleReason: string;
  flags: string[];
  independentSources: number;
  sourcesWithData: string[];
  uniqueStories: number;
  totalSample: number;
  aggregateLogGrowth: number | null;
  aggregateAcceleration: number | null;
  perSource: SourceBreakdown[];
}

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;
const toMs = (d: Date | number) => (typeof d === "number" ? d : d.getTime());

function mapGrowth(g: number, scale: number): number {
  return 50 + 50 * Math.tanh(g / scale);
}

interface WindowAgg {
  volume: number | null;
  interactions: number | null;
  views: number | null;
  sample: number;
  rows: number;
  newestCollected: number | null;
  qualitySum: number;
}

function emptyAgg(): WindowAgg {
  return { volume: null, interactions: null, views: null, sample: 0, rows: 0, newestCollected: null, qualitySum: 0 };
}

function addNullable(a: number | null, b: number | null | undefined): number | null {
  if (b === null || b === undefined || Number.isNaN(b)) return a;
  return (a ?? 0) + b;
}

/** Aggregates one source's observations into recent + baseline windows. */
function aggregateWindows(obs: ObservationInput[], profile: SourceProfile, asOf: number, cfg: ScoringConfig, covered: boolean[] | undefined): WindowAgg[] {
  const W = cfg.windowHours * 3600_000;
  const n = cfg.baselineWindows + 1;
  const aggs = Array.from({ length: n }, emptyAgg);
  const interestPoints: number[][] = Array.from({ length: n }, () => []);

  for (const o of obs) {
    const t = toMs(o.observedAt);
    if (t > asOf) continue; // never look into the future (backtests depend on this)
    const w = Math.floor((asOf - t) / W);
    if (w < 0 || w >= n) continue;
    const a = aggs[w];
    a.rows++;
    a.qualitySum += o.dataQuality ?? 1;
    const collected = o.collectedAt !== undefined ? toMs(o.collectedAt) : t;
    a.newestCollected = Math.max(a.newestCollected ?? 0, Math.min(collected, asOf));
    switch (profile.volumeMetric) {
      case "search_interest":
        if (o.searchInterest !== null && o.searchInterest !== undefined) {
          interestPoints[w].push(o.searchInterest);
          a.sample++;
        }
        break;
      case "new_views":
        a.volume = addNullable(a.volume, o.newViews);
        a.sample += o.sampleSize ?? 0;
        break;
      case "discussion":
        a.volume = addNullable(addNullable(a.volume, o.newPosts), o.newComments);
        a.sample += o.sampleSize ?? 0;
        break;
      case "new_posts":
        // Deduplicated story count when available, so syndicated copies are counted once.
        a.volume = addNullable(a.volume, o.uniqueStories ?? o.newPosts);
        a.sample += o.sampleSize ?? 0;
        break;
    }
    if (profile.hasEngagement) {
      a.interactions = addNullable(addNullable(a.interactions, o.newLikes), o.newComments);
      a.views = addNullable(a.views, o.newViews);
    }
  }

  for (let w = 0; w < n; w++) {
    if (profile.volumeMetric === "search_interest") {
      const pts = interestPoints[w];
      aggs[w].volume = pts.length ? pts.reduce((x, y) => x + y, 0) / pts.length : null;
    } else if (aggs[w].rows === 0 && covered?.[w]) {
      // Provider collected successfully but nothing matched this topic: a measured zero.
      aggs[w].volume = 0;
      if (profile.hasEngagement) {
        aggs[w].interactions = 0;
        aggs[w].views = 0;
      }
    }
  }
  return aggs;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function weightedMean(pairs: Array<[number, number]>): number | null {
  const tw = pairs.reduce((a, [, w]) => a + w, 0);
  if (tw <= 0) return null;
  return pairs.reduce((a, [v, w]) => a + v * w, 0) / tw;
}

/** Percentile rank of v within values (0-100), ties counted half. */
export function percentileRank(v: number, values: number[]): number {
  if (values.length === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const x of values) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return (100 * (below + 0.5 * equal)) / values.length;
}

function analyseSource(
  source: string,
  obs: ObservationInput[],
  topic: TopicInput,
  asOf: number,
  cfg: ScoringConfig,
  coverage: Coverage | undefined,
  population: Population | undefined,
): SourceBreakdown {
  const profile = sourceProfile(source);
  const aggs = aggregateWindows(obs, profile, asOf, cfg, coverage?.[source]);
  const vols = aggs.map((a) => a.volume);
  const R = vols[0];
  const baselineVals = vols.slice(1).filter((v): v is number => v !== null);
  const B = baselineVals.length ? mean(baselineVals) : null;
  const sample = aggs.reduce((s, a) => s + a.sample, 0);
  const alpha = profile.smoothing;
  const recentRows = aggs[0].rows;

  const out: SourceBreakdown = {
    source,
    platform: profile.platform,
    windows: vols,
    recent: R,
    baseline: B,
    baselineWindows: baselineVals.length,
    sample,
    logGrowth: null,
    pctGrowth: null,
    zScore: null,
    acceleration: null,
    velocity: null,
    engagement: null,
    interactionsPerHourRecent: null,
    interactionsPerHourBaseline: null,
    engagementRateRecent: null,
    engagementRateBaseline: null,
    attentionPercentile: null,
    growing: false,
    independent: false,
    newestCollectedAt: aggs.reduce<number | null>((m, a) => (a.newestCollected !== null && (m === null || a.newestCollected > m) ? a.newestCollected : m), null),
    freshness: null,
    avgDataQuality: recentRows ? aggs[0].qualitySum / recentRows : null,
  };

  if (out.newestCollectedAt !== null) {
    const ageH = (asOf - out.newestCollectedAt) / 3600_000;
    out.freshness = Math.exp(-Math.max(0, ageH) / profile.staleAfterHours);
  }

  // ---- velocity ----
  if (R === null) out.velocityUnavailableReason = "no_recent_data";
  else if (B === null) out.velocityUnavailableReason = "no_baseline";
  else if (sample < profile.minSample) out.velocityUnavailableReason = "below_min_sample";
  else {
    const g = Math.log((R + alpha) / (B + alpha));
    out.logGrowth = g;
    out.pctGrowth = (R - B) / Math.max(B, alpha);
    let v = mapGrowth(g, cfg.growthScale);
    if (baselineVals.length >= 3) {
      // Compare against the topic's own historical variability, floored so a flat history can't explode z.
      const sd = Math.max(std(baselineVals), Math.sqrt(B + alpha));
      const z = (R - B) / sd;
      out.zScore = z;
      v = 0.7 * v + 0.3 * (50 + 50 * Math.tanh(z / 3));
    }
    const v1 = vols[1];
    const v2 = vols[2];
    if (v1 !== null && v1 !== undefined && v2 !== null && v2 !== undefined) {
      const accel = Math.log((R + alpha) / (v1 + alpha)) - Math.log((v1 + alpha) / (v2 + alpha));
      out.acceleration = accel;
      v += 8 * Math.tanh(accel / cfg.growthScale);
    }
    out.velocity = clamp(v);
    out.growing = g >= cfg.growingThreshold;
  }

  // ---- engagement momentum (same source, same content type, vs the topic's own past) ----
  if (!profile.hasEngagement) out.engagementUnavailableReason = "source_has_no_engagement_metrics";
  else {
    const I = aggs.map((a) => a.interactions);
    const IR = I[0];
    const IB = I.slice(1).filter((v): v is number => v !== null);
    if (IR === null || IB.length === 0) out.engagementUnavailableReason = "missing_interactions";
    else if (sample < profile.minSample) out.engagementUnavailableReason = "below_min_sample";
    else {
      const base = mean(IB);
      const ae = profile.engagementSmoothing;
      out.interactionsPerHourRecent = IR / cfg.windowHours;
      out.interactionsPerHourBaseline = base / cfg.windowHours;
      let e = mapGrowth(Math.log((IR + ae) / (base + ae)), cfg.growthScale);
      // Engagement rate (interactions per view) is only meaningful where views are measured.
      const views = aggs.map((a) => a.views);
      const VR = views[0];
      const VBs = views.slice(1).filter((v): v is number => v !== null && v > 0);
      if (VR !== null && VR > 0 && VBs.length) {
        const erR = IR / VR;
        const erB = IB.reduce((a, b) => a + b, 0) / VBs.reduce((a, b) => a + b, 0);
        out.engagementRateRecent = erR;
        out.engagementRateBaseline = erB;
        const eps = 0.002;
        e = 0.7 * e + 0.3 * mapGrowth(Math.log((erR + eps) / (erB + eps)), Math.log(2));
      }
      out.engagement = clamp(e);
    }
  }

  // ---- attention (level vs comparable topics within this source) ----
  if (R !== null) {
    const pop = population?.recentVolumes[source];
    if (pop && pop.length >= 5) out.attentionPercentile = percentileRank(R, pop);
    else if (pop && pop.length > 0) {
      const max = Math.max(...pop, R);
      out.attentionPercentile = max > 0 ? (100 * Math.log1p(R)) / Math.log1p(max) : 0;
    }
  }
  return out;
}

export function scoreTopic(
  topic: TopicInput,
  asOfInput: Date | number,
  cfg: ScoringConfig = defaultScoringConfig,
  ctx: { coverage?: Coverage; population?: Population } = {},
): ScoreResult {
  const asOf = toMs(asOfInput);
  const bySource = new Map<string, ObservationInput[]>();
  for (const o of topic.observations) {
    const list = bySource.get(o.source) ?? [];
    list.push(o);
    bySource.set(o.source, list);
  }
  // Include sources that collected (coverage) even if this topic has no rows: that is a measured zero.
  for (const s of Object.keys(ctx.coverage ?? {})) if (!bySource.has(s)) bySource.set(s, []);

  const perSource = [...bySource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, obs]) => analyseSource(source, obs, topic, asOf, cfg, ctx.coverage, ctx.population))
    .filter((s) => s.windows.some((v) => v !== null));

  const rel = (s: SourceBreakdown) => sourceProfile(s.source).reliability;

  // ---- cross-platform independence ----
  const stories = topic.recentStories ?? {};
  const growing = perSource.filter((s) => s.growing);
  // A story already credited to one platform cannot confirm the trend again elsewhere
  // (a Reddit post linking the same article, a syndicated wire copy). Sources are visited in
  // a fixed order so the outcome is deterministic.
  const claimed = new Set<string>();
  for (const s of growing) {
    const own = stories[s.source] ?? [];
    // Search interest has no stories and is independent by construction; a source whose growth
    // comes from engagement on older items (no recent stories) shares nothing with the others.
    s.independent = sourceProfile(s.source).volumeMetric === "search_interest" || own.length === 0 || own.some((k) => !claimed.has(k));
    for (const k of own) claimed.add(k);
  }
  const independentPlatforms = new Set(growing.filter((s) => s.independent).map((s) => s.platform));
  const nIndependent = independentPlatforms.size;
  const uniqueStoryKeys = new Set(growing.flatMap((s) => stories[s.source] ?? []));
  const uniqueStories = uniqueStoryKeys.size;

  // ---- components ----
  const velocityPairs = perSource.filter((s) => s.velocity !== null).map((s): [number, number] => [s.velocity!, rel(s)]);
  const velocity = weightedMean(velocityPairs);
  const engagement = weightedMean(perSource.filter((s) => s.engagement !== null).map((s): [number, number] => [s.engagement!, rel(s)]));

  let crossPlatform: number | null = null;
  if (velocityPairs.length > 0) {
    const ladder = [0, 35, 70, 90, 100];
    const base = ladder[Math.min(nIndependent, 4)];
    const storySources = growing.filter((s) => sourceProfile(s.source).volumeMetric !== "search_interest");
    // Many signals that all trace back to one underlying story are penalized.
    const diversity = storySources.length === 0 || !topic.recentStories ? 1 : 0.5 + 0.5 * Math.min(1, Math.max(0, uniqueStories - 1) / 2);
    crossPlatform = clamp(base * diversity);
  }

  const attentionRaw = weightedMean(perSource.filter((s) => s.attentionPercentile !== null).map((s): [number, number] => [s.attentionPercentile!, rel(s)]));
  // Large but stagnant or declining topics keep only part of their attention credit.
  const attention = attentionRaw === null ? null : clamp(attentionRaw * (velocity === null ? 0.6 : clamp(0.4 + velocity / 100, 0.4, 1)));

  const components: Record<ComponentName, number | null> = {
    velocity: velocity === null ? null : round1(velocity),
    engagement: engagement === null ? null : round1(engagement),
    crossPlatform: crossPlatform === null ? null : round1(crossPlatform),
    attention: attention === null ? null : round1(attention),
    relevance: topic.relevance === null ? null : round1(clamp(topic.relevance)),
  };

  const { trendScore, coverage, missingComponents } = combineComponents(components, cfg);

  // ---- confidence ----
  const totalSample = perSource.reduce((a, s) => a + s.sample, 0);
  const withVelocity = perSource.filter((s) => s.velocity !== null);
  const platformsWithData = new Set(withVelocity.map((s) => s.platform));
  const freshness = weightedMean(perSource.filter((s) => s.freshness !== null).map((s): [number, number] => [s.freshness!, rel(s)])) ?? 0;
  const aggregateLogGrowth = weightedMean(withVelocity.map((s): [number, number] => [s.logGrowth!, rel(s)]));
  let consistency = 0;
  if (withVelocity.length === 1) consistency = 0.5;
  else if (withVelocity.length > 1 && aggregateLogGrowth !== null) {
    const dir = Math.sign(aggregateLogGrowth) || 1;
    const agree = withVelocity.filter((s) => (Math.sign(s.logGrowth!) || 1) === dir).length / withVelocity.length;
    consistency = clamp((agree - 0.5) * 2, 0, 1);
  }
  const quality = weightedMean(perSource.filter((s) => s.avgDataQuality !== null).map((s): [number, number] => [s.avgDataQuality!, rel(s)])) ?? 1;
  const confidenceParts = {
    sources: Math.min(1, platformsWithData.size / 3),
    sample: 1 - Math.exp(-totalSample / 25),
    freshness,
    consistency,
    completeness: coverage * quality,
  };
  const cw = cfg.confidenceWeights;
  const cwTotal = cw.sources + cw.sample + cw.freshness + cw.consistency + cw.completeness;
  const confidence = round1(
    clamp(
      (100 *
        (cw.sources * confidenceParts.sources +
          cw.sample * confidenceParts.sample +
          cw.freshness * confidenceParts.freshness +
          cw.consistency * confidenceParts.consistency +
          cw.completeness * confidenceParts.completeness)) /
        cwTotal,
    ),
  );

  const aggregateAcceleration = weightedMean(withVelocity.filter((s) => s.acceleration !== null).map((s): [number, number] => [s.acceleration!, rel(s)]));
  const { lifecycle, reason } = classifyLifecycle({ perSource, aggregateLogGrowth, aggregateAcceleration, nIndependent, cfg, topic, asOf });

  const flags: string[] = [];
  if (confidence < cfg.lowConfidence) flags.push("low_confidence");
  if (trendScore >= cfg.highScore && confidence < cfg.lowConfidence) flags.push("high_score_low_confidence");
  if (platformsWithData.size === 1) flags.push("single_source");
  if (freshness < 0.3) flags.push("stale_data");
  if (missingComponents.length) flags.push("partial_components");
  if (growing.length > 1 && uniqueStories === 1) flags.push("single_underlying_story");

  return {
    topicId: topic.topicId,
    asOf,
    trendScore,
    components,
    attentionRaw: attentionRaw === null ? null : round1(attentionRaw),
    missingComponents,
    coverage: Math.round(coverage * 1000) / 1000,
    confidence,
    confidenceParts,
    lifecycle,
    lifecycleReason: reason,
    flags,
    independentSources: nIndependent,
    sourcesWithData: [...platformsWithData].sort(),
    uniqueStories,
    totalSample,
    aggregateLogGrowth,
    aggregateAcceleration,
    perSource,
  };
}

function classifyLifecycle(p: {
  perSource: SourceBreakdown[];
  aggregateLogGrowth: number | null;
  aggregateAcceleration: number | null;
  nIndependent: number;
  cfg: ScoringConfig;
  topic: TopicInput;
  asOf: number;
}): { lifecycle: Lifecycle; reason: string } {
  const { cfg } = p;
  const usable = p.perSource.filter((s) => s.velocity !== null);
  if (usable.length === 0 || p.aggregateLogGrowth === null) return { lifecycle: "insufficient_data", reason: "No source has enough observations to measure growth." };

  // Composite series: each source normalized to its own peak, then reliability-weighted.
  const n = cfg.baselineWindows + 1;
  const composite: Array<number | null> = [];
  for (let w = 0; w < n; w++) {
    const pairs: Array<[number, number]> = [];
    for (const s of usable) {
      const peak = Math.max(...s.windows.filter((v): v is number => v !== null), 0);
      const v = s.windows[w];
      if (v !== null && v !== undefined && peak > 0) pairs.push([v / peak, sourceProfile(s.source).reliability]);
      else if (v === 0) pairs.push([0, sourceProfile(s.source).reliability]);
    }
    composite.push(weightedMean(pairs));
  }
  const windowsWithData = composite.filter((c) => c !== null).length;
  if (windowsWithData < cfg.minLifecycleWindows) {
    return { lifecycle: "insufficient_data", reason: `Only ${windowsWithData} of ${cfg.minLifecycleWindows} required windows have data.` };
  }

  const g = p.aggregateLogGrowth;
  const accel = p.aggregateAcceleration;
  const current = composite[0] ?? 0;
  const peak = Math.max(...composite.filter((c): c is number => c !== null));
  const baseline = composite.slice(1).filter((c): c is number => c !== null);
  const baselineMean = baseline.length ? mean(baseline) : 0;
  const prev = composite[1];
  // Short-term growth: recent window vs the window just before it.
  const shortGrowth = prev !== null && prev !== undefined ? Math.log((current + 0.05) / (prev + 0.05)) : null;
  const young = p.topic.firstSeenAt !== undefined && p.asOf - toMs(p.topic.firstSeenAt) < 3 * cfg.windowHours * 3600_000;
  const pct = (x: number) => `${Math.round((Math.exp(x) - 1) * 100)}%`;

  if (peak <= 0 || current <= 0.1) return { lifecycle: "dormant", reason: "Current activity is at or below 10% of its observed peak." };
  // Peaking is a shape, not a score: elevated over the baseline, at its high, but no longer growing window over window.
  if (g >= cfg.growingThreshold && current >= 0.8 * peak && shortGrowth !== null && shortGrowth < Math.log(1.1) && accel !== null && accel < 0) {
    return { lifecycle: "peaking", reason: `Still ${pct(g)} above its baseline and near its observed high, but growth has stalled window over window.` };
  }
  if (g >= cfg.growingThreshold && (young || baselineMean < 0.1)) {
    return { lifecycle: "emerging", reason: `Growing ${pct(g)} from ${young ? "a newly detected topic" : "a near-zero baseline"}.` };
  }
  if (g >= Math.log(3) && p.nIndependent >= 2) return { lifecycle: "breakout", reason: `Up ${pct(g)} vs baseline, confirmed by ${p.nIndependent} independent sources.` };
  if (g >= cfg.growingThreshold) return { lifecycle: "rising", reason: `Up ${pct(g)} vs its own baseline${accel !== null && accel > 0 ? ", and accelerating" : ""}.` };
  if (g <= -cfg.growingThreshold) return { lifecycle: "cooling", reason: `Down ${Math.round((1 - Math.exp(g)) * 100)}% vs its own baseline.` };
  return { lifecycle: "stable", reason: "Activity is within ±25% of its own baseline." };
}

/**
 * Weighted combination of the 0-100 components. Missing components are excluded and the
 * remaining weights rescaled; below cfg.minCoverage the result shrinks toward 0. Exported so
 * backtests can re-weight precomputed components without rescoring.
 */
export function combineComponents(
  components: Record<ComponentName, number | null>,
  cfg: Pick<ScoringConfig, "weights" | "minCoverage">,
): { trendScore: number; coverage: number; missingComponents: ComponentName[] } {
  const keys = Object.keys(cfg.weights) as ComponentName[];
  const missingComponents = keys.filter((k) => components[k] === null);
  const availableWeight = keys.filter((k) => components[k] !== null).reduce((a, k) => a + cfg.weights[k], 0);
  const totalWeight = keys.reduce((a, k) => a + cfg.weights[k], 0);
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;
  // A score needs at least one observed (not editorial) component.
  const observed = (["velocity", "engagement", "crossPlatform", "attention"] as ComponentName[]).some((k) => components[k] !== null);
  let trendScore = 0;
  if (observed && availableWeight > 0) {
    trendScore = keys.reduce((a, k) => a + (components[k] === null ? 0 : cfg.weights[k] * components[k]!), 0) / availableWeight;
    // Proportional reweighting is only trusted when enough of the formula is measured. Below
    // minCoverage the score shrinks toward 0, so level-only or editorial-only signals
    // (attention + relevance with no measured growth) cannot produce a high trend score.
    trendScore *= Math.min(1, coverage / cfg.minCoverage);
  }
  return { trendScore: round1(clamp(trendScore)), coverage, missingComponents };
}

/** Deterministic ranking: score, then confidence, then topic id. */
export function rankResults<T extends { trendScore: number; confidence: number; topicId: string }>(results: T[]): T[] {
  return [...results].sort((a, b) => b.trendScore - a.trendScore || b.confidence - a.confidence || a.topicId.localeCompare(b.topicId));
}

/** Builds the attention population (recent-window volume per source) from a set of topics. */
export function buildPopulation(topics: TopicInput[], asOf: Date | number, cfg: ScoringConfig = defaultScoringConfig, coverage?: Coverage): Population {
  const recentVolumes: Record<string, number[]> = {};
  const t = toMs(asOf);
  for (const topic of topics) {
    const sources = new Set(topic.observations.map((o) => o.source));
    for (const s of sources) {
      const aggs = aggregateWindows(
        topic.observations.filter((o) => o.source === s),
        sourceProfile(s),
        t,
        { ...cfg, baselineWindows: 0 },
        coverage?.[s],
      );
      const v = aggs[0].volume;
      if (v !== null) (recentVolumes[s] ??= []).push(v);
    }
  }
  return { recentVolumes };
}
