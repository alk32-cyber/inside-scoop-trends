import { sourcesConfig } from "../config";
import type { CollectResult, ProviderAdapter, ProviderContext, RawItem } from "./types";

const API = "https://www.googleapis.com/youtube/v3";

interface SearchResponse {
  items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string } }>;
}
interface VideosResponse {
  items?: Array<{
    id: string;
    snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }>;
}

const num = (v: string | undefined) => (v === undefined ? null : Number(v));

/**
 * YouTube Data API v3 (https://developers.google.com/youtube/v3).
 * Quota: search.list = 100 units, videos.list = 1 unit per call (up to 50 ids).
 * Default project quota is 10,000 units/day; the schedule in config.ts stays inside it.
 */
export const youtubeAdapter: ProviderAdapter = {
  name: "youtube",
  label: "YouTube Data API v3",
  attribution: "Data from YouTube Data API Services",
  docsUrl: "https://developers.google.com/youtube/v3/getting-started",
  minIntervalMs: 200,
  configStatus(env) {
    const missing = env.YOUTUBE_API_KEY ? [] : ["YOUTUBE_API_KEY"];
    return { configured: missing.length === 0, missing };
  },
  secrets: (env) => [env.YOUTUBE_API_KEY],

  async check(ctx) {
    const key = ctx.env.YOUTUBE_API_KEY!;
    const res = await ctx.http.json<VideosResponse>(`${API}/videos?part=id&chart=mostPopular&maxResults=1&regionCode=US&key=${encodeURIComponent(key)}`);
    return `ok (${res.items?.length ?? 0} item returned)`;
  },

  async collect(ctx: ProviderContext): Promise<CollectResult> {
    const key = ctx.env.YOUTUBE_API_KEY!;
    const cfg = sourcesConfig.youtube;
    const warnings: string[] = [];
    const publishedAfter = new Date(ctx.now.getTime() - cfg.lookbackHours * 3600_000).toISOString();
    const found = new Map<string, { rank: number; query: string }>();

    for (const q of cfg.searchQueries) {
      const params = new URLSearchParams({
        part: "snippet",
        type: "video",
        order: "date",
        q,
        publishedAfter,
        maxResults: String(cfg.maxResultsPerQuery),
        regionCode: cfg.regionCode,
        relevanceLanguage: cfg.relevanceLanguage,
        key,
      });
      try {
        const res = await ctx.http.json<SearchResponse>(`${API}/search?${params}`);
        (res.items ?? []).forEach((it, i) => {
          const id = it.id?.videoId;
          if (id && !found.has(id)) found.set(id, { rank: i + 1, query: q });
        });
      } catch (err) {
        if ((err as Error).name === "BudgetExceededError") throw err;
        warnings.push(ctx.http.redact(`search "${q}" failed: ${(err as Error).message}`));
      }
    }

    // Refresh counters for videos collected in the last N days so view/like deltas can be measured.
    const tracked = await ctx.trackedExternalIds(cfg.refreshTrackedForDays);
    const ids = [...new Set([...found.keys(), ...tracked])];
    const items: RawItem[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      try {
        const res = await ctx.http.json<VideosResponse>(`${API}/videos?part=snippet,statistics&id=${batch.join(",")}&key=${encodeURIComponent(key)}`);
        for (const v of res.items ?? []) {
          const s = v.snippet ?? {};
          items.push({
            externalId: v.id,
            url: `https://www.youtube.com/watch?v=${v.id}`,
            contentType: "video",
            title: s.title ?? "",
            snippet: (s.description ?? "").slice(0, 500),
            author: s.channelTitle ?? null,
            publishedAt: s.publishedAt ? new Date(s.publishedAt) : null,
            views: num(v.statistics?.viewCount),
            // likeCount is absent when the channel hides it; it stays null rather than 0.
            likes: num(v.statistics?.likeCount),
            comments: num(v.statistics?.commentCount),
            rank: found.get(v.id)?.rank ?? null,
            meta: { query: found.get(v.id)?.query ?? null },
          });
        }
      } catch (err) {
        if ((err as Error).name === "BudgetExceededError") {
          warnings.push("request budget reached while refreshing video statistics");
          break;
        }
        warnings.push(ctx.http.redact(`videos.list failed: ${(err as Error).message}`));
      }
    }
    return { items, warnings };
  },
};
