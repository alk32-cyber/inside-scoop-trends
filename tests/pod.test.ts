import { describe, expect, it } from "vitest";
import { coverageScore, inSentence, podScore, starters, teenAppeal, tierFor } from "@/lib/pod";

const NOW = Date.UTC(2026, 9, 26, 12);
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const hl = (title: string, outlet = "Outlet", hoursAgo = 3) => ({ title, url: `https://example.com/${encodeURIComponent(title)}`, outlet, publishedAt: iso(hoursAgo) });

describe("teen appeal", () => {
  it("puts topics in the lane teens recognise", () => {
    expect(teenAppeal("MrBeast", ["MrBeast launches new snack brand"]).lane.id).toBe("creators");
    expect(teenAppeal("Roblox", ["Roblox creators earned more this year"]).lane.id).toBe("gaming");
    expect(teenAppeal("Side hustles", []).lane.id).toBe("money");
    expect(teenAppeal("United Airlines", ["United Airlines changes fees"]).lane.id).toBe("other");
  });

  it("pushes heavy news and vague single words down", () => {
    const light = teenAppeal("TikTok Shop", ["TikTok Shop sellers report record sales"]);
    const heavy = teenAppeal("TikTok", ["Senate votes on TikTok ban lawsuit", "Court hears TikTok lawsuit"]);
    expect(heavy.heavy).toBe(true);
    expect(heavy.appeal).toBeLessThan(light.appeal);
    const vague = teenAppeal("IPO", ["Company files for IPO"]);
    expect(vague.vague).toBe(true);
    expect(vague.appeal).toBeLessThan(teenAppeal("Anthropic IPO", ["Anthropic files for IPO"]).appeal);
  });
});

describe("pod score ranking", () => {
  const base = { trendScore: 60, lifecycle: "rising" };

  it("ranks a teen-relevant, widely covered topic above a dull corporate one", () => {
    const teen = podScore({ ...base, name: "Roblox", headlines: [hl("Roblox pays creators $1B"), hl("Roblox adds new teen safety tools", "B")], stories: 4, outlets: 3, newestAt: iso(2) }, NOW);
    const dull = podScore({ ...base, name: "American Express", headlines: [hl("American Express quarterly results")], stories: 4, outlets: 3, newestAt: iso(2) }, NOW);
    expect(teen.podScore).toBeGreaterThan(dull.podScore);
    expect(["hot", "solid"]).toContain(teen.tier);
  });

  it("never ranks a single-story topic above maybe", () => {
    const one = podScore({ ...base, trendScore: 100, name: "MrBeast", headlines: [hl("MrBeast news")], stories: 1, outlets: 1, newestAt: iso(1) }, NOW);
    expect(one.podScore).toBeLessThanOrEqual(45);
    expect(["maybe", "skip"]).toContain(one.tier);
  });

  it("rewards fresh coverage from more outlets and gives friendly reasons and starters", () => {
    const fresh = podScore({ ...base, name: "Nike", headlines: [hl("Nike drops new sneaker")], stories: 5, outlets: 4, newestAt: iso(2) }, NOW);
    const stale = podScore({ ...base, name: "Nike", headlines: [hl("Nike drops new sneaker", "A", 80)], stories: 2, outlets: 1, newestAt: iso(80) }, NOW);
    expect(fresh.podScore).toBeGreaterThan(stale.podScore);
    expect(fresh.reasons.some((r) => r.includes("outlets"))).toBe(true);
    expect(fresh.starters).toHaveLength(3);
    expect(fresh.starters.join(" ")).not.toContain("{T}");
  });

  it("keeps scores within 0-100 and maps tiers", () => {
    expect(coverageScore(0, 0)).toBe(0);
    expect(coverageScore(8, 5)).toBe(100);
    expect(tierFor(80)).toBe("hot");
    expect(tierFor(60)).toBe("solid");
    expect(tierFor(45)).toBe("maybe");
    expect(tierFor(10)).toBe("skip");
  });
});

describe("conversation starters", () => {
  it("reads naturally mid-sentence", () => {
    expect(inSentence("Salary negotiation")).toBe("salary negotiation");
    expect(inSentence("TikTok Shop")).toBe("TikTok Shop");
    expect(inSentence("AI agents")).toBe("AI agents");
    expect(starters("Salary negotiation", "money").join(" ")).toContain("about salary negotiation");
    expect(starters("Side hustles", "other")[0].charAt(0)).toBe("E");
  });
});
