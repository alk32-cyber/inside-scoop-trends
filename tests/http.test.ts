import { describe, expect, it } from "vitest";
import { BudgetExceededError, HttpClient, ProviderHttpError } from "@/lib/providers/http";
import { parseFeed } from "@/lib/providers/news";

function fakeFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> } | "network">) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const r = responses.shift();
    if (!r || r === "network") throw new TypeError("fetch failed");
    return new Response(r.body ?? "{}", { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("HttpClient", () => {
  it("retries transient errors with exponential backoff and honours Retry-After", async () => {
    const sleeps: number[] = [];
    const { impl, calls } = fakeFetch([{ status: 503 }, "network", { status: 429, headers: { "retry-after": "7" } }, { status: 200, body: '{"ok":true}' }]);
    const http = new HttpClient({ provider: "t", budget: 10, fetchImpl: impl, sleep: async (ms) => void sleeps.push(ms), baseDelayMs: 100 });
    expect(await http.json("https://x.test/a")).toEqual({ ok: true });
    expect(calls).toHaveLength(4);
    expect(sleeps[0]).toBeGreaterThanOrEqual(50);
    expect(sleeps[1]).toBeGreaterThanOrEqual(100);
    expect(sleeps[2]).toBeGreaterThanOrEqual(7000); // Retry-After wins over the shorter backoff
  });

  it("does not retry client errors and redacts secrets from messages", async () => {
    const { impl, calls } = fakeFetch([{ status: 403, body: "quota exceeded for key SECRET123" }]);
    const http = new HttpClient({ provider: "yt", budget: 10, fetchImpl: impl, sleep: async () => {}, secrets: ["SECRET123"] });
    const err = (await http.json("https://x.test/v3/search?q=a&key=SECRET123").catch((e: unknown) => e)) as ProviderHttpError;
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(calls).toHaveLength(1);
    expect(err.message).not.toContain("SECRET123");
    expect(err.message).toContain("[redacted]");
  });

  it("stops at the request budget", async () => {
    const { impl } = fakeFetch([{ status: 200 }, { status: 200 }, { status: 200 }]);
    const http = new HttpClient({ provider: "t", budget: 2, fetchImpl: impl, sleep: async () => {} });
    await http.json("https://x.test/1");
    await http.json("https://x.test/2");
    await expect(http.json("https://x.test/3")).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe("RSS parsing", () => {
  it("reads RSS items and Atom entries", () => {
    const rss = `<rss><channel><item><title><![CDATA[Founders &amp; funding]]></title><link>https://ex.com/a?utm_source=rss</link><pubDate>Mon, 20 Oct 2026 10:00:00 GMT</pubDate><description>Short &lt;b&gt;summary&lt;/b&gt;</description></item></channel></rss>`;
    const [item] = parseFeed(rss, "https://ex.com/feed");
    expect(item.title).toBe("Founders & funding");
    expect(item.externalId).toBe("https://ex.com/a");
    expect(item.publishedAt?.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    const atom = `<feed><entry><title>Atom title</title><link href="https://ex.com/b"/><updated>2026-10-21T08:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom, "https://ex.com/atom")[0].url).toBe("https://ex.com/b");
  });
});
