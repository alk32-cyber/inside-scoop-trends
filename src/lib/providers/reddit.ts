import { sourcesConfig } from "../config";
import type { CollectResult, ProviderAdapter, ProviderContext, RawItem } from "./types";

interface Listing {
  data?: {
    children?: Array<{
      kind: string;
      data: {
        id: string;
        name: string;
        title: string;
        selftext?: string;
        permalink: string;
        url?: string;
        is_self?: boolean;
        author?: string;
        subreddit?: string;
        created_utc?: number;
        score?: number;
        num_comments?: number;
        over_18?: boolean;
        removed_by_category?: string | null;
      };
    }>;
  };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(ctx: ProviderContext): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const id = ctx.env.REDDIT_CLIENT_ID!;
  const secret = ctx.env.REDDIT_CLIENT_SECRET!;
  const res = await ctx.http.json<{ access_token: string; expires_in: number }>("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  cachedToken = { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
  return res.access_token;
}

function isExternalLink(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return !/(^|\.)(reddit\.com|redd\.it|imgur\.com|redditmedia\.com)$/.test(h);
  } catch {
    return false;
  }
}

/**
 * Reddit Data API via OAuth2 application-only (client credentials) flow.
 * Free tier: 100 queries/minute per OAuth client. Commercial use requires Reddit's approval.
 * Only titles, a short snippet and public counters are stored; see README "Reddit data handling".
 */
export const redditAdapter: ProviderAdapter = {
  name: "reddit",
  label: "Reddit Data API",
  attribution: "Content from Reddit, linked to the original thread",
  docsUrl: "https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki",
  minIntervalMs: 700, // stays under 100 QPM
  configStatus(env) {
    const missing = ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT"].filter((k) => !env[k]);
    return { configured: missing.length === 0, missing, notes: "User agent format required by Reddit: <platform>:<app id>:<version> (by /u/<username>)" };
  },
  secrets: (env) => [env.REDDIT_CLIENT_SECRET, env.REDDIT_CLIENT_ID],
  userAgent: (env) => env.REDDIT_USER_AGENT ?? "web:inside-scoop-trends:0.1.0",

  async check(ctx) {
    const token = await accessToken(ctx);
    const res = await ctx.http.json<Listing>("https://oauth.reddit.com/r/Entrepreneur/new?limit=1&raw_json=1", { headers: { Authorization: `Bearer ${token}` } });
    return `ok (${res.data?.children?.length ?? 0} post returned)`;
  },

  async collect(ctx): Promise<CollectResult> {
    const cfg = sourcesConfig.reddit;
    const warnings: string[] = [];
    const token = await accessToken(ctx);
    const items = new Map<string, RawItem>();

    for (const sub of cfg.subreddits) {
      for (const listing of cfg.listings) {
        try {
          const res = await ctx.http.json<Listing>(`https://oauth.reddit.com/r/${encodeURIComponent(sub)}/${listing}?limit=${cfg.limitPerListing}&raw_json=1`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          (res.data?.children ?? []).forEach((c, i) => {
            const d = c.data;
            if (c.kind !== "t3" || d.over_18 || d.removed_by_category) return;
            const prev = items.get(d.name);
            const rank = listing === "hot" ? i + 1 : (prev?.rank ?? null);
            items.set(d.name, {
              externalId: d.name,
              url: `https://www.reddit.com${d.permalink}`,
              linkedUrl: !d.is_self && isExternalLink(d.url) ? d.url : null,
              contentType: "post",
              title: d.title,
              snippet: (d.selftext ?? "").slice(0, 300) || null,
              author: d.subreddit ? `r/${d.subreddit}` : null,
              publishedAt: d.created_utc ? new Date(d.created_utc * 1000) : null,
              views: null, // Reddit does not expose view counts
              likes: typeof d.score === "number" ? d.score : null,
              comments: typeof d.num_comments === "number" ? d.num_comments : null,
              rank,
              meta: { subreddit: d.subreddit },
            });
          });
        } catch (err) {
          if ((err as Error).name === "BudgetExceededError") throw err;
          warnings.push(ctx.http.redact(`r/${sub}/${listing} failed: ${(err as Error).message}`));
        }
      }
    }

    // Refresh counters for recently tracked posts that fell out of the listings (100 ids per call).
    const tracked = (await ctx.trackedExternalIds(cfg.refreshTrackedForDays)).filter((id) => !items.has(id));
    const removed: string[] = [];
    for (let i = 0; i < tracked.length; i += 100) {
      try {
        const res = await ctx.http.json<Listing>(`https://oauth.reddit.com/by_id/${tracked.slice(i, i + 100).join(",")}?raw_json=1`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        for (const c of res.data?.children ?? []) {
          const d = c.data;
          // Removed or deleted posts are dropped; their stored text is purged by the pipeline.
          if (d.removed_by_category || d.title === "[deleted]" || d.title === "[removed]") {
            removed.push(d.name);
            continue;
          }
          items.set(d.name, {
            externalId: d.name,
            url: `https://www.reddit.com${d.permalink}`,
            linkedUrl: !d.is_self && isExternalLink(d.url) ? d.url : null,
            contentType: "post",
            title: d.title,
            snippet: (d.selftext ?? "").slice(0, 300) || null,
            author: d.subreddit ? `r/${d.subreddit}` : null,
            publishedAt: d.created_utc ? new Date(d.created_utc * 1000) : null,
            views: null,
            likes: typeof d.score === "number" ? d.score : null,
            comments: typeof d.num_comments === "number" ? d.num_comments : null,
            rank: null,
            meta: { subreddit: d.subreddit },
          });
        }
      } catch (err) {
        if ((err as Error).name === "BudgetExceededError") {
          warnings.push("request budget reached while refreshing tracked posts");
          break;
        }
        warnings.push(ctx.http.redact(`by_id refresh failed: ${(err as Error).message}`));
      }
    }
    return { items: [...items.values()], removedExternalIds: removed, warnings };
  },
};
