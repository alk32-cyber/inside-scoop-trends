import { sourcesConfig } from "../config";
import { canonicalizeUrl } from "../normalize/text";
import type { CollectResult, ProviderAdapter, RawItem } from "./types";

interface NewsApiResponse {
  status: string;
  articles?: Array<{ source?: { name?: string }; author?: string | null; title?: string; description?: string | null; url?: string; publishedAt?: string }>;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : null;
}

/** Minimal RSS 2.0 / Atom parser: title, link, publication time, summary. */
export function parseFeed(xml: string, feedUrl: string): RawItem[] {
  const items: RawItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const feedHost = (() => {
    try {
      return new URL(feedUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  })();
  for (const b of blocks) {
    const title = tag(b, "title");
    let link = tag(b, "link");
    if (!link) link = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? null;
    if (!title || !link) continue;
    const when = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const published = when ? new Date(when) : null;
    items.push({
      externalId: canonicalizeUrl(link),
      url: link,
      contentType: "article",
      title,
      snippet: (tag(b, "description") ?? tag(b, "summary") ?? "").slice(0, 400) || null,
      author: feedHost,
      publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
      meta: { feed: feedUrl },
    });
  }
  return items;
}

function rssFeeds(env: Record<string, string | undefined>): string[] {
  const fromEnv = (env.NEWS_RSS_FEEDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...sourcesConfig.news.rssFeeds, ...fromEnv])];
}

/**
 * News: NewsAPI.org (licensed API, https://newsapi.org/docs) and/or RSS feeds you are
 * permitted to use. NewsAPI's free Developer plan is for development only and delays
 * articles; production use needs a paid plan. Stored: headline, short description, URL.
 */
export const newsAdapter: ProviderAdapter = {
  name: "news",
  label: "News (NewsAPI.org / RSS)",
  attribution: "Headlines link to the original publisher",
  docsUrl: "https://newsapi.org/docs/endpoints/everything",
  minIntervalMs: 250,
  configStatus(env) {
    const hasKey = Boolean(env.NEWSAPI_KEY);
    const feeds = rssFeeds(env).length;
    return {
      configured: hasKey || feeds > 0,
      missing: hasKey || feeds > 0 ? [] : ["NEWSAPI_KEY or NEWS_RSS_FEEDS"],
      notes: `${hasKey ? "NewsAPI key set" : "no NewsAPI key"}; ${feeds} RSS feed(s)`,
    };
  },
  secrets: (env) => [env.NEWSAPI_KEY],
  userAgent: () => "inside-scoop-trends/0.1 (+trend research)",

  async check(ctx) {
    const out: string[] = [];
    if (ctx.env.NEWSAPI_KEY) {
      const res = await ctx.http.json<NewsApiResponse>("https://newsapi.org/v2/top-headlines?country=us&category=business&pageSize=1", { headers: { "X-Api-Key": ctx.env.NEWSAPI_KEY } });
      out.push(`NewsAPI ${res.status}`);
    }
    for (const f of rssFeeds(ctx.env).slice(0, 3)) {
      const xml = await ctx.http.text(f, { headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
      out.push(`${f}: ${parseFeed(xml, f).length} items`);
    }
    return out.join("; ");
  },

  async collect(ctx): Promise<CollectResult> {
    const cfg = sourcesConfig.news;
    const warnings: string[] = [];
    const items = new Map<string, RawItem>();
    const from = new Date(ctx.now.getTime() - cfg.lookbackHours * 3600_000).toISOString();

    if (ctx.env.NEWSAPI_KEY) {
      for (const q of cfg.queries) {
        const params = new URLSearchParams({ q, from, language: "en", sortBy: "publishedAt", pageSize: String(cfg.pageSize) });
        try {
          const res = await ctx.http.json<NewsApiResponse>(`https://newsapi.org/v2/everything?${params}`, { headers: { "X-Api-Key": ctx.env.NEWSAPI_KEY } });
          for (const a of res.articles ?? []) {
            if (!a.url || !a.title || a.title === "[Removed]") continue;
            const id = canonicalizeUrl(a.url);
            if (items.has(id)) continue;
            items.set(id, {
              externalId: id,
              url: a.url,
              contentType: "article",
              title: a.title,
              snippet: a.description?.slice(0, 400) ?? null,
              author: a.source?.name ?? null,
              publishedAt: a.publishedAt ? new Date(a.publishedAt) : null,
              meta: { query: q, outlet: a.source?.name ?? null },
            });
          }
        } catch (err) {
          if ((err as Error).name === "BudgetExceededError") throw err;
          warnings.push(ctx.http.redact(`NewsAPI "${q}" failed: ${(err as Error).message}`));
        }
      }
    }

    for (const f of rssFeeds(ctx.env)) {
      try {
        const xml = await ctx.http.text(f, { headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
        for (const it of parseFeed(xml, f)) if (!items.has(it.externalId)) items.set(it.externalId, it);
      } catch (err) {
        if ((err as Error).name === "BudgetExceededError") throw err;
        warnings.push(ctx.http.redact(`RSS ${f} failed: ${(err as Error).message}`));
      }
    }
    return { items: [...items.values()], warnings };
  },
};
