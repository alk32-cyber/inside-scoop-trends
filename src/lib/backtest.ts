import type { Db } from "./db";
import { sourceProfile, type ComponentName, type ScoringConfig } from "./config";
import { loadCoverage, loadTopicInputs } from "./pipeline/score";
import { buildPopulation, combineComponents, scoreTopic, type ObservationInput, type ScoreResult, type TopicInput } from "./scoring/score";

/**
 * Backtesting against saved observations.
 *
 * For each historical cutoff t, topics are scored using only data observed and collected
 * by t. The outcome is whether each topic then gained attention over the next horizon:
 * the reliability-weighted log change of measured volume in (t, t+H] vs (t-H, t].
 *
 * Metrics per cutoff (then averaged):
 *  - spearman:     rank correlation between trend score and subsequent gain
 *  - precisionAtK: share of the top-K topics that subsequently gained attention
 *  - baseline:     the same precision when ranking by current attention only (popularity)
 */

export interface BacktestOptions {
  isDemo?: boolean;
  stepHours?: number;
  horizonHours?: number;
  k?: number;
  /** Minimum topics with a measurable outcome for a cutoff to count. */
  minTopics?: number;
}

interface CutoffSample {
  cutoff: Date;
  rows: Array<{ topicId: string; result: ScoreResult; gain: number; attention: number }>;
}

function volume(obs: ObservationInput[], from: number, to: number, metric: string): number | null {
  const inRange = obs.filter((o) => {
    const t = typeof o.observedAt === "number" ? o.observedAt : o.observedAt.getTime();
    return t > from && t <= to;
  });
  if (inRange.length === 0) return null;
  if (metric === "search_interest") {
    const pts = inRange.map((o) => o.searchInterest).filter((v): v is number => v !== null && v !== undefined);
    return pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null;
  }
  let sum = 0;
  for (const o of inRange) {
    if (metric === "new_views") sum += o.newViews ?? 0;
    else if (metric === "discussion") sum += (o.newPosts ?? 0) + (o.newComments ?? 0);
    else sum += o.uniqueStories ?? o.newPosts ?? 0;
  }
  return sum;
}

/** Subsequent attention gain for one topic: weighted mean of per-source log changes. */
export function futureGain(topic: TopicInput, cutoff: number, horizonMs: number): number | null {
  const bySource = new Map<string, ObservationInput[]>();
  for (const o of topic.observations) bySource.set(o.source, [...(bySource.get(o.source) ?? []), o]);
  let num = 0;
  let den = 0;
  for (const [source, obs] of bySource) {
    const p = sourceProfile(source);
    const before = volume(obs, cutoff - horizonMs, cutoff, p.volumeMetric);
    const after = volume(obs, cutoff, cutoff + horizonMs, p.volumeMetric);
    if (before === null && after === null) continue;
    num += p.reliability * Math.log(((after ?? 0) + p.smoothing) / ((before ?? 0) + p.smoothing));
    den += p.reliability;
  }
  return den > 0 ? num / den : null;
}

function spearman(a: number[], b: number[]): number | null {
  if (a.length < 3) return null;
  const rank = (xs: number[]) => {
    const idx = xs.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : null;
}

export interface Metrics {
  cutoffs: number;
  spearman: number | null;
  precisionAtK: number | null;
  baselinePrecisionAtK: number | null;
}

function evaluate(samples: CutoffSample[], weights: Record<ComponentName, number>, cfg: ScoringConfig, k: number): Metrics {
  const sp: number[] = [];
  const pk: number[] = [];
  const bk: number[] = [];
  for (const s of samples) {
    const scored = s.rows.map((r) => ({ ...r, score: combineComponents(r.result.components, { weights, minCoverage: cfg.minCoverage }).trendScore }));
    const rho = spearman(
      scored.map((r) => r.score),
      scored.map((r) => r.gain),
    );
    if (rho !== null) sp.push(rho);
    const kk = Math.min(k, scored.length);
    const top = [...scored].sort((a, b) => b.score - a.score || a.topicId.localeCompare(b.topicId)).slice(0, kk);
    pk.push(top.filter((r) => r.gain > 0).length / kk);
    const pop = [...scored].sort((a, b) => b.attention - a.attention || a.topicId.localeCompare(b.topicId)).slice(0, kk);
    bk.push(pop.filter((r) => r.gain > 0).length / kk);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
  return { cutoffs: samples.length, spearman: avg(sp), precisionAtK: avg(pk), baselinePrecisionAtK: avg(bk) };
}

/** All weight vectors on a 0.05 grid where every component keeps at least 0.05. */
function weightGrid(): Array<Record<ComponentName, number>> {
  const out: Array<Record<ComponentName, number>> = [];
  const n = 20;
  for (let a = 1; a < n; a++)
    for (let b = 1; a + b < n; b++)
      for (let c = 1; a + b + c < n; c++)
        for (let d = 1; a + b + c + d < n; d++) {
          const e = n - a - b - c - d;
          if (e < 1) continue;
          out.push({ velocity: a / n, engagement: b / n, crossPlatform: c / n, attention: d / n, relevance: e / n });
        }
  return out;
}

export async function collectSamples(db: Db, cfg: ScoringConfig, opts: BacktestOptions = {}): Promise<CutoffSample[]> {
  const isDemo = opts.isDemo ?? false;
  const step = (opts.stepHours ?? 6) * 3600_000;
  const horizon = (opts.horizonHours ?? cfg.windowHours) * 3600_000;
  const [range] = await db.query<{ lo: Date | null; hi: Date | null }>("SELECT MIN(observed_at) AS lo, MAX(observed_at) AS hi FROM observations WHERE is_demo = $1", [isDemo]);
  if (!range?.lo || !range.hi) return [];
  // Need at least two windows of history before a cutoff and a full horizon after it.
  const start = new Date(range.lo).getTime() + 2 * cfg.windowHours * 3600_000;
  const end = new Date(range.hi).getTime() - horizon;
  const samples: CutoffSample[] = [];
  for (let t = start; t <= end; t += step) {
    const cutoff = new Date(t);
    const inputs = await loadTopicInputs(db, cutoff, cfg, isDemo);
    if (inputs.length === 0) continue;
    // Outcome observations are loaded separately; scoring never sees them.
    const outcome = await loadTopicInputs(db, new Date(t + horizon), { ...cfg, baselineWindows: 1, windowHours: horizon / 3600_000 }, isDemo, { topicIds: inputs.map((i) => i.topicId) });
    const outcomeBy = new Map(outcome.map((o) => [o.topicId, o]));
    const coverage = await loadCoverage(db, cutoff, cfg, isDemo);
    const population = buildPopulation(inputs, cutoff, cfg, coverage);
    const rows: CutoffSample["rows"] = [];
    for (const input of inputs) {
      const result = scoreTopic(input, cutoff, cfg, { coverage, population });
      const o = outcomeBy.get(input.topicId);
      const gain = o ? futureGain(o, t, horizon) : null;
      if (gain === null) continue;
      rows.push({ topicId: input.topicId, result, gain, attention: result.attentionRaw ?? 0 });
    }
    if (rows.length >= (opts.minTopics ?? 5)) samples.push({ cutoff, rows });
  }
  return samples;
}

export interface BacktestReport {
  dataMode: "live" | "demo";
  k: number;
  horizonHours: number;
  defaultWeights: Record<ComponentName, number>;
  defaultMetrics: Metrics;
  tuning: null | {
    trainCutoffs: number;
    testCutoffs: number;
    bestWeights: Record<ComponentName, number>;
    trainMetrics: Metrics;
    testMetrics: Metrics;
    defaultTestMetrics: Metrics;
    recommendation: string;
  };
  notes: string[];
}

/** Runs the backtest and a train/test weight search. Never changes the live configuration. */
export async function runBacktest(db: Db, cfg: ScoringConfig, opts: BacktestOptions = {}): Promise<BacktestReport> {
  const k = opts.k ?? 5;
  const samples = await collectSamples(db, cfg, opts);
  const notes: string[] = [];
  if (opts.isDemo) notes.push("Run on SIMULATED demo data: results only show that the procedure works, not how well the weights predict real trends.");
  if (samples.length < 10) notes.push(`Only ${samples.length} usable cutoffs; collect at least a few weeks of live data before trusting tuned weights.`);
  notes.push("Topics are those known today; topics discovered later are included at earlier cutoffs only if they had observations then (mild survivorship bias).");

  const report: BacktestReport = {
    dataMode: opts.isDemo ? "demo" : "live",
    k,
    horizonHours: opts.horizonHours ?? cfg.windowHours,
    defaultWeights: cfg.weights,
    defaultMetrics: evaluate(samples, cfg.weights, cfg, k),
    tuning: null,
    notes,
  };
  if (samples.length < 4) return report;

  // Chronological split: tune on the earlier 70%, judge on the later 30%.
  const split = Math.max(1, Math.floor(samples.length * 0.7));
  const train = samples.slice(0, split);
  const test = samples.slice(split);
  let best = cfg.weights;
  let bestScore = -Infinity;
  for (const w of weightGrid()) {
    const m = evaluate(train, w, cfg, k);
    // Objective: rank correlation, with precision@K as a tie-breaker.
    const objective = (m.spearman ?? -1) + 0.25 * (m.precisionAtK ?? 0);
    if (objective > bestScore + 1e-9) {
      bestScore = objective;
      best = w;
    }
  }
  const testMetrics = evaluate(test, best, cfg, k);
  const defaultTestMetrics = evaluate(test, cfg.weights, cfg, k);
  const improves = (testMetrics.spearman ?? -1) > (defaultTestMetrics.spearman ?? -1) + 0.05;
  report.tuning = {
    trainCutoffs: train.length,
    testCutoffs: test.length,
    bestWeights: best,
    trainMetrics: evaluate(train, best, cfg, k),
    testMetrics,
    defaultTestMetrics,
    recommendation: improves
      ? `Tuned weights beat the defaults on held-out cutoffs. To adopt them set SCORING_WEIGHTS='${JSON.stringify(best)}'.`
      : "Tuned weights do not clearly beat the defaults on held-out cutoffs; keep the current weights.",
  };
  return report;
}
