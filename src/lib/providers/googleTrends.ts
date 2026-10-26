import { sourcesConfig } from "../config";
import type { CollectResult, InterestSeries, ProviderAdapter } from "./types";

interface SerpApiTrends {
  search_metadata?: { status?: string; google_trends_url?: string };
  error?: string;
  interest_over_time?: {
    timeline_data?: Array<{ timestamp?: string; partial_data?: boolean; values?: Array<{ query?: string; extracted_value?: number }> }>;
  };
}

/**
 * Google Trends search interest.
 *
 * Google does not offer a generally available public Trends API. Two authorized routes:
 *   1. SerpApi's Google Trends engine (implemented here; paid, documented at
 *      https://serpapi.com/google-trends-api). Set SERPAPI_KEY.
 *   2. Google's official Trends API (alpha, approval required). When access is granted,
 *      implement a second adapter with the same InterestSeries output.
 *
 * Values are Google's 0-100 normalized interest *relative to the requested timeframe*.
 * They are never treated as absolute search volume. Each run re-fetches the whole
 * timeframe and replaces stored points, because Google re-normalizes the series.
 */
export const googleTrendsAdapter: ProviderAdapter = {
  name: "google_trends",
  label: "Google Trends (via SerpApi)",
  attribution: "Search interest data: Google Trends",
  docsUrl: "https://serpapi.com/google-trends-api",
  minIntervalMs: 1000,
  configStatus(env) {
    const missing = env.SERPAPI_KEY ? [] : ["SERPAPI_KEY"];
    return { configured: missing.length === 0, missing, notes: "Queries the top active topics each run; costs 1 SerpApi search per topic." };
  },
  secrets: (env) => [env.SERPAPI_KEY],

  async check(ctx) {
    const res = await ctx.http.json<{ account_status?: string; plan_searches_left?: number }>(`https://serpapi.com/account.json?api_key=${encodeURIComponent(ctx.env.SERPAPI_KEY!)}`);
    return `ok (account ${res.account_status ?? "unknown"}, ${res.plan_searches_left ?? "?"} searches left)`;
  },

  async collect(ctx): Promise<CollectResult> {
    const cfg = sourcesConfig.googleTrends;
    const warnings: string[] = [];
    const interest: InterestSeries[] = [];
    const topics = await ctx.topicsForInterest(cfg.maxTopicsPerRun);
    if (topics.length === 0) warnings.push("no active topics to query yet; Trends runs after other sources have produced topics");

    for (const t of topics) {
      const params = new URLSearchParams({ engine: "google_trends", q: t.query, data_type: "TIMESERIES", date: cfg.timeframe, geo: cfg.geo, api_key: ctx.env.SERPAPI_KEY! });
      try {
        const res = await ctx.http.json<SerpApiTrends>(`https://serpapi.com/search.json?${params}`);
        if (res.error) {
          warnings.push(`"${t.query}": ${res.error}`);
          continue;
        }
        const points = (res.interest_over_time?.timeline_data ?? [])
          .filter((p) => p.timestamp && typeof p.values?.[0]?.extracted_value === "number")
          .map((p) => ({ time: new Date(Number(p.timestamp) * 1000), value: p.values![0].extracted_value!, partial: Boolean(p.partial_data) }));
        const exploreUrl =
          res.search_metadata?.google_trends_url ??
          `https://trends.google.com/trends/explore?${new URLSearchParams({ q: t.query, date: cfg.timeframe, geo: cfg.geo })}`;
        interest.push({ topicId: t.topicId, query: t.query, sourceUrl: exploreUrl, points });
      } catch (err) {
        if ((err as Error).name === "BudgetExceededError") {
          warnings.push("request budget reached");
          break;
        }
        warnings.push(ctx.http.redact(`"${t.query}" failed: ${(err as Error).message}`));
      }
    }
    return { items: [], interest, warnings };
  },
};
