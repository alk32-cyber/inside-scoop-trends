import type { Coverage, ObservationInput } from "@/lib/scoring/score";
import { defaultScoringConfig } from "@/lib/config";

export const ASOF = Date.UTC(2026, 9, 20, 12, 0, 0);
export const W = defaultScoringConfig.windowHours * 3600_000;
export const NWIN = defaultScoringConfig.baselineWindows + 1;

/**
 * One observation per window, oldest first: values[0] is the oldest baseline
 * window, values[last] is the recent window. Each row sits mid-window.
 */
export function series(
  source: string,
  values: number[],
  metric: (v: number) => Partial<ObservationInput>,
  opts: { asOf?: number; collectedLagMs?: number } = {},
): ObservationInput[] {
  const asOf = opts.asOf ?? ASOF;
  const n = values.length;
  return values.map((v, i) => {
    const windowIndex = n - 1 - i; // 0 = recent
    const observedAt = asOf - windowIndex * W - W / 2;
    return { source, observedAt, collectedAt: observedAt + (opts.collectedLagMs ?? 0), dataQuality: 1, ...metric(v) };
  });
}

export const newsPosts = (v: number) => ({ newPosts: v, uniqueStories: v, sampleSize: v });
export const ytViews = (v: number) => ({ newViews: v, newLikes: Math.round(v * 0.04), newComments: Math.round(v * 0.005), newPosts: 1, sampleSize: 3 });
export const redditDiscussion = (v: number) => ({ newPosts: Math.round(v / 10), newComments: v, newLikes: v * 3, sampleSize: Math.max(1, Math.round(v / 10)) });
export const trendsInterest = (v: number) => ({ searchInterest: v, sampleSize: 1 });

export function fullCoverage(...sources: string[]): Coverage {
  return Object.fromEntries(sources.map((s) => [s, Array(NWIN).fill(true)]));
}
