import { describe, expect, it } from "vitest";
import { buildPopulation, rankResults, scoreTopic, type TopicInput } from "@/lib/scoring/score";
import { defaultScoringConfig, loadScoringConfig } from "@/lib/config";
import { ASOF, fullCoverage, newsPosts, redditDiscussion, series, trendsInterest, W, ytViews } from "./helpers";

const cfg = defaultScoringConfig;
const coverage = fullCoverage("news", "youtube", "reddit");

function score(topics: TopicInput[], asOf = ASOF, cov = coverage) {
  const population = buildPopulation(topics, asOf, cfg, cov);
  return rankResults(topics.map((t) => scoreTopic(t, asOf, cfg, { coverage: cov, population })));
}

describe("velocity and ranking", () => {
  it("ranks a genuinely accelerating topic above an otherwise similar stagnant topic", () => {
    const accelerating: TopicInput = {
      topicId: "accelerating",
      relevance: 80,
      observations: [...series("news", [6, 6, 6, 6, 6, 9, 18], newsPosts), ...series("youtube", [20e3, 20e3, 21e3, 20e3, 22e3, 35e3, 80e3], ytViews)],
    };
    const stagnant: TopicInput = {
      topicId: "stagnant",
      relevance: 80,
      observations: [...series("news", [9, 9, 9, 9, 9, 9, 9], newsPosts), ...series("youtube", [40e3, 40e3, 40e3, 40e3, 40e3, 40e3, 40e3], ytViews)],
    };
    const [first, second] = score([stagnant, accelerating]);
    expect(first.topicId).toBe("accelerating");
    expect(first.components.velocity!).toBeGreaterThan(second.components.velocity!);
    expect(first.aggregateAcceleration!).toBeGreaterThan(0);
    expect(second.lifecycle).toBe("stable");
  });

  it("does not automatically rank a popular but declining topic first", () => {
    const declining: TopicInput = {
      topicId: "big-declining",
      relevance: 90,
      observations: [...series("youtube", [900e3, 850e3, 800e3, 700e3, 600e3, 450e3, 300e3], ytViews), ...series("news", [40, 38, 36, 30, 26, 20, 14], newsPosts)],
    };
    const rising: TopicInput = {
      topicId: "small-rising",
      relevance: 80,
      observations: [...series("youtube", [15e3, 16e3, 15e3, 18e3, 22e3, 30e3, 55e3], ytViews), ...series("news", [3, 3, 4, 3, 5, 7, 11], newsPosts)],
    };
    const filler: TopicInput[] = [1, 2, 3, 4].map((i) => ({
      topicId: `filler-${i}`,
      relevance: 50,
      observations: [...series("youtube", Array(7).fill(10e3 * i), ytViews), ...series("news", Array(7).fill(2 * i), newsPosts)],
    }));
    const ranked = score([declining, rising, ...filler]);
    expect(ranked[0].topicId).toBe("small-rising");
    const big = ranked.find((r) => r.topicId === "big-declining")!;
    expect(big.attentionRaw!).toBeGreaterThan(90); // it really is the biggest topic...
    expect(big.components.attention!).toBeLessThan(big.attentionRaw!); // ...but stagnation damping applies
    expect(big.lifecycle).toBe("cooling");
  });

  it("does not let a tiny sample produce a false breakout", () => {
    const tiny: TopicInput = { topicId: "tiny", relevance: 100, observations: series("news", [0, 0, 0, 0, 0, 0, 2], newsPosts) };
    const [r] = score([tiny], ASOF, fullCoverage("news"));
    expect(r.components.velocity).toBeNull();
    expect(r.perSource[0].velocityUnavailableReason).toBe("below_min_sample");
    expect(r.lifecycle).toBe("insufficient_data");
    expect(r.trendScore).toBeLessThan(50);

    // Just above the sample threshold, 0 -> 3 posts is still damped by smoothing and cannot be a breakout.
    const small: TopicInput = { topicId: "small", relevance: 100, observations: series("news", [0, 0, 0, 0, 0, 0, 3], newsPosts) };
    const [s] = score([small], ASOF, fullCoverage("news"));
    expect(s.lifecycle).not.toBe("breakout");
    expect(s.components.velocity!).toBeLessThan(85);
    expect(s.flags).toContain("single_source");
  });

  it("classifies a large multi-source surge as a breakout", () => {
    const t: TopicInput = {
      topicId: "surge",
      relevance: 90,
      observations: [
        ...series("news", [4, 5, 4, 5, 4, 8, 30], newsPosts),
        ...series("youtube", [10e3, 11e3, 10e3, 12e3, 11e3, 30e3, 150e3], ytViews),
        ...series("reddit", [40, 45, 40, 50, 45, 120, 400], redditDiscussion),
      ],
      recentStories: { news: ["n1", "n2", "n3"], youtube: ["y1", "y2"], reddit: ["r1", "r2"] },
    };
    const [r] = score([t]);
    expect(r.lifecycle).toBe("breakout");
    expect(r.independentSources).toBe(3);
    expect(r.confidence).toBeGreaterThan(60);
  });
});

describe("cross-platform confirmation", () => {
  const growthObs = [...series("news", [3, 3, 3, 3, 3, 5, 12], newsPosts), ...series("reddit", [30, 30, 30, 30, 30, 60, 150], redditDiscussion)];

  it("does not let one duplicated story inflate cross-platform confirmation", () => {
    const duplicated: TopicInput = { topicId: "dup", relevance: 70, observations: growthObs, recentStories: { news: ["url:https://example.com/a"], reddit: ["url:https://example.com/a"] } };
    const independent: TopicInput = { topicId: "indep", relevance: 70, observations: growthObs, recentStories: { news: ["url:https://example.com/a", "fp:b"], reddit: ["reddit:x", "reddit:y"] } };
    const cov = fullCoverage("news", "reddit");
    const d = scoreTopic(duplicated, ASOF, cfg, { coverage: cov });
    const i = scoreTopic(independent, ASOF, cfg, { coverage: cov });
    expect(d.independentSources).toBe(1);
    expect(i.independentSources).toBe(2);
    expect(d.flags).toContain("single_underlying_story");
    expect(d.components.crossPlatform!).toBeLessThan(i.components.crossPlatform!);
    expect(d.trendScore).toBeLessThan(i.trendScore);
  });

  it("reduces confidence when only one source confirms a trend", () => {
    const one: TopicInput = { topicId: "one", relevance: 70, observations: series("news", [3, 3, 3, 3, 3, 5, 12], newsPosts) };
    const two: TopicInput = { topicId: "two", relevance: 70, observations: growthObs, recentStories: { news: ["a"], reddit: ["b"] } };
    const a = scoreTopic(one, ASOF, cfg, { coverage: fullCoverage("news") });
    const b = scoreTopic(two, ASOF, cfg, { coverage: fullCoverage("news", "reddit") });
    expect(a.confidence).toBeLessThan(b.confidence);
    expect(a.flags).toContain("single_source");
  });
});

describe("missing data", () => {
  it("does not treat a missing provider as zero and reweights available components", () => {
    const t: TopicInput = { topicId: "news-only", relevance: 80, observations: series("news", [5, 5, 5, 5, 5, 6, 10], newsPosts) };
    // YouTube never collected: no coverage, no rows. Engagement must be missing, not zero.
    const r = scoreTopic(t, ASOF, cfg, { coverage: fullCoverage("news") });
    expect(r.components.engagement).toBeNull();
    expect(r.missingComponents).toContain("engagement");
    expect(r.flags).toContain("partial_components");
    const w = cfg.weights;
    const c = r.components;
    const expected =
      (w.velocity * c.velocity! + w.crossPlatform * c.crossPlatform! + w.relevance * c.relevance! + (c.attention === null ? 0 : w.attention * c.attention)) /
      (w.velocity + w.crossPlatform + w.relevance + (c.attention === null ? 0 : w.attention));
    expect(r.trendScore).toBeCloseTo(expected, 0);
    expect(r.coverage).toBeLessThan(1);
    expect(Number.isFinite(r.trendScore)).toBe(true);
  });

  it("distinguishes a measured zero (provider collected, nothing matched) from missing data", () => {
    const obs = series("youtube", [10e3, 10e3, 10e3, 10e3, 10e3, 10e3, 10e3], ytViews).slice(0, 6); // no recent row
    const t: TopicInput = { topicId: "went-quiet", relevance: 50, observations: obs };
    const measured = scoreTopic(t, ASOF, cfg, { coverage: fullCoverage("youtube") });
    const missing = scoreTopic(t, ASOF, cfg, {});
    expect(measured.perSource[0].recent).toBe(0);
    expect(measured.lifecycle).toBe("dormant");
    expect(missing.perSource[0].recent).toBeNull();
    expect(missing.components.velocity).toBeNull();
  });

  it("returns zero with no observed components rather than scoring on relevance alone", () => {
    const r = scoreTopic({ topicId: "empty", relevance: 100, observations: [] }, ASOF, cfg, {});
    expect(r.trendScore).toBe(0);
    expect(r.lifecycle).toBe("insufficient_data");
  });

  it("ignores observations after the as-of time", () => {
    const base = series("news", [5, 5, 5, 5, 5, 5, 5], newsPosts);
    const future = [{ source: "news", observedAt: ASOF + 3600_000, newPosts: 500, uniqueStories: 500, sampleSize: 500 }];
    const a = scoreTopic({ topicId: "t", relevance: 50, observations: base }, ASOF, cfg, { coverage: fullCoverage("news") });
    const b = scoreTopic({ topicId: "t", relevance: 50, observations: [...base, ...future] }, ASOF, cfg, { coverage: fullCoverage("news") });
    expect(b).toEqual(a);
  });
});

describe("freshness and confidence", () => {
  it("lowers freshness and confidence when data is old", () => {
    const obs = [...series("news", [3, 3, 3, 3, 3, 6, 12], newsPosts), ...series("reddit", [30, 30, 30, 30, 30, 60, 150], redditDiscussion)];
    const t: TopicInput = { topicId: "t", relevance: 70, observations: obs, recentStories: { news: ["a"], reddit: ["b"] } };
    const fresh = scoreTopic(t, ASOF, cfg, { coverage: fullCoverage("news", "reddit") });
    // Same data viewed 30 hours later with no new collections (no coverage for the new period).
    const later = ASOF + 30 * 3600_000;
    const stale = scoreTopic(t, later, cfg, {});
    expect(stale.confidenceParts.freshness).toBeLessThan(fresh.confidenceParts.freshness);
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.flags).toContain("stale_data");
  });

  it("flags high scores with low confidence", () => {
    const t: TopicInput = {
      topicId: "shaky",
      relevance: 100,
      // One source, one video per window, poor data quality: a sharp spike nobody else confirms.
      observations: series("youtube", [5e3, 5e3, 5e3, 5e3, 5e3, 20e3, 120e3], (v) => ({ ...ytViews(v), sampleSize: 1, dataQuality: 0.3 })),
    };
    const r = scoreTopic(t, ASOF, cfg, { coverage: fullCoverage("youtube") });
    expect(r.trendScore).toBeGreaterThanOrEqual(cfg.highScore);
    expect(r.confidence).toBeLessThan(cfg.lowConfidence);
    expect(r.flags).toEqual(expect.arrayContaining(["high_score_low_confidence", "low_confidence", "single_source"]));
  });
});

describe("bounds and determinism", () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
  }

  it("keeps every score and component within 0-100 and is deterministic", () => {
    const rand = rng(42);
    const topics: TopicInput[] = Array.from({ length: 40 }, (_, i) => {
      const pick = (scale: number) => Array.from({ length: 7 }, () => Math.round(rand() * scale * (rand() < 0.2 ? 0 : 1)));
      return {
        topicId: `t${String(i).padStart(2, "0")}`,
        relevance: rand() < 0.1 ? null : Math.round(rand() * 100),
        observations: [
          ...(rand() < 0.8 ? series("news", pick(30), newsPosts) : []),
          ...(rand() < 0.7 ? series("youtube", pick(500e3), ytViews) : []),
          ...(rand() < 0.6 ? series("reddit", pick(800), redditDiscussion) : []),
          ...(rand() < 0.5 ? series("google_trends", pick(100), trendsInterest) : []),
        ],
        recentStories: { news: [`n${i}`], youtube: [`y${i}`], reddit: [rand() < 0.5 ? `n${i}` : `r${i}`] },
      };
    });
    const cov = fullCoverage("news", "youtube", "reddit");
    const run1 = score(topics, ASOF, cov);
    const run2 = score([...topics].reverse(), ASOF, cov);
    expect(run2.map((r) => r.topicId)).toEqual(run1.map((r) => r.topicId));
    for (const r of run1) {
      expect(r.trendScore).toBeGreaterThanOrEqual(0);
      expect(r.trendScore).toBeLessThanOrEqual(100);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(100);
      for (const v of Object.values(r.components)) if (v !== null) expect(v >= 0 && v <= 100 && Number.isFinite(v)).toBe(true);
    }
  });

  it("breaks ties by confidence, then topic id", () => {
    const ranked = rankResults([
      { topicId: "b", trendScore: 50, confidence: 40 },
      { topicId: "a", trendScore: 50, confidence: 40 },
      { topicId: "c", trendScore: 50, confidence: 70 },
    ]);
    expect(ranked.map((r) => r.topicId)).toEqual(["c", "a", "b"]);
  });

  it("renormalizes configured weights", () => {
    const c = loadScoringConfig({ SCORING_WEIGHTS: JSON.stringify({ velocity: 3, engagement: 1, crossPlatform: 1, attention: 0, relevance: 0 }) });
    expect(c.weights.velocity).toBeCloseTo(0.6);
    expect(Object.values(c.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});
