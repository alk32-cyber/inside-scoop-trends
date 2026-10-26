import { describe, expect, it } from "vitest";
import { assignCategory, assignStoryKey, candidateSupport, matchCurated, selectTopics, shouldMerge } from "@/lib/normalize/grouping";
import { canonicalKey, canonicalizeUrl, extractCandidates, surfaceForm, titleFingerprint } from "@/lib/normalize/text";

describe("canonical keys and aliases", () => {
  it("folds capitalization, punctuation, plurals and coverage words into one key", () => {
    const variants = ["Side Hustles", "side-hustle", "SIDE HUSTLE explained", "side hustles: news"];
    expect(new Set(variants.map(canonicalKey))).toEqual(new Set(["side hustle"]));
    expect(canonicalKey("Tik Tok Shop")).toBe(canonicalKey("TikTok shop"));
    expect(canonicalKey("4-day work week")).toBe(canonicalKey("four day work week"));
    expect(canonicalKey("Gen-Z")).toBe("gen z");
  });

  it("groups similar keywords into one curated topic", () => {
    const titles = ["The 4-day week is coming to startups", "Four day work week trial results", "Is a 32 hour work week realistic?"];
    for (const t of titles) expect(matchCurated(t).map((m) => m.topicId)).toEqual(["four-day-work-week"]);
  });

  it("does not merge unrelated subjects that share a word", () => {
    expect(matchCurated("Apple Pay adds installment loans").map((m) => m.topicId)).toEqual(["apple-pay"]);
    expect(matchCurated("Apple Vision Pro sales slow").map((m) => m.topicId)).toEqual(["apple-vision-pro"]);
    expect(matchCurated("TikTok Shop sellers brace for fees").map((m) => m.topicId)).toEqual(["tiktok-shop"]);
    expect(shouldMerge({ id: "apple-pay", key: "apple pay", category: "finance_education" }, { id: "apple-vision-pro", key: "apple vision pro", category: "technology" }, 0.95)).toBe(false);
    expect(shouldMerge({ id: "tiktok-shop", key: "tiktok shop", category: "marketing" }, { id: "tiktok-ban", key: "tiktok ban", category: "marketing" }, 0.99)).toBe(false);
  });

  it("uses context to disambiguate ambiguous names", () => {
    expect(matchCurated("Meta shares jump after Zuckerberg unveils new glasses").map((m) => m.topicId)).toContain("meta-platforms");
    expect(matchCurated("The meta for ranked play changed this season").map((m) => m.topicId)).not.toContain("meta-platforms");
  });

  it("only merges semantically when embeddings agree, categories match and words overlap", () => {
    const a = { id: "creator-economy", key: "creator economy", category: "entrepreneurship" };
    const b = { id: "creator-economies", key: "creator economy job", category: "entrepreneurship" };
    expect(shouldMerge(a, b, null)).toBe(false); // no embeddings: deterministic only
    expect(shouldMerge(a, b, 0.93)).toBe(true);
    expect(shouldMerge(a, { ...b, category: "marketing" }, 0.93)).toBe(false);
    expect(shouldMerge(a, { id: "x", key: "influencer marketing", category: "entrepreneurship" }, 0.95)).toBe(false);
  });
});

describe("candidate extraction", () => {
  it("finds multi-word phrases and drops generic single words", () => {
    const keys = extractCandidates("Why Gen Z founders are building vending machine businesses").map((c) => c.key);
    expect(keys).toContain("vending machine business");
    expect(keys).not.toContain("business");
    expect(keys).not.toContain("why");
  });

  it("only lets proper nouns become single-word topics", () => {
    const entityItems = ["Investors pile into Nvidia again", "Why chipmakers trail Nvidia", "The Nvidia effect on startups"].map((t, i) => ({ id: i, text: t, storyKey: `s${i}` }));
    expect(selectTopics(candidateSupport(entityItems)).map((s) => s.key)).toContain("nvidia");
    const verbItems = ["Founders keep building", "Still building after layoffs", "Building through a downturn"].map((t, i) => ({ id: i, text: t, storyKey: `b${i}` }));
    expect(selectTopics(candidateSupport(verbItems)).map((s) => s.key)).not.toContain("building");
  });

  it("requires distinct stories, so one syndicated story cannot create a topic", () => {
    const items = [1, 2, 3, 4].map((i) => ({ id: i, text: "Quantum payroll startup raises seed round", storyKey: "url:https://example.com/a" }));
    expect(selectTopics(candidateSupport(items))).toEqual([]);
    const distinct = [1, 2, 3].map((i) => ({ id: i, text: `Quantum payroll startup story ${i}`, storyKey: `s${i}` }));
    expect(selectTopics(candidateSupport(distinct)).map((s) => s.key)).toContain("quantum payroll startup");
  });

  it("keeps the specific phrase when sub-phrases have the same support", () => {
    const items = ["Vending machine business is booming", "My vending machine business after a year", "Vending machine business mistakes"].map((t, i) => ({ id: i, text: t, storyKey: `s${i}` }));
    const keys = selectTopics(candidateSupport(items)).map((s) => s.key);
    expect(keys).toContain("vending machine business");
    expect(keys).not.toContain("vending machine");
    expect(keys).not.toContain("vending");
  });

  it("does not turn words inside a curated mention into new topics", () => {
    const items = ["TikTok Shop fees rise", "TikTok Shop sellers react", "How TikTok Shop affiliates earn"].map((t, i) => ({ id: i, text: t, storyKey: `s${i}` }));
    expect(selectTopics(candidateSupport(items)).map((s) => s.key)).not.toContain("shop");
  });

  it("recovers the usual written form for display", () => {
    expect(surfaceForm("creator led brand", ["Why creator-led brands win", "creator-led brands are everywhere"])).toBe("Creator-led brands");
    expect(surfaceForm("tiktok shop", ["The TikTok Shop gold rush"])).toBe("TikTok Shop");
  });
});

describe("duplicate detection", () => {
  it("canonicalizes URLs so tracking variants are the same item", () => {
    expect(canonicalizeUrl("http://www.example.com/story/?utm_source=x&fbclid=1#top")).toBe("https://example.com/story");
    expect(canonicalizeUrl("https://youtu.be/abc123")).toBe(canonicalizeUrl("https://www.youtube.com/watch?v=abc123&feature=share"));
    expect(canonicalizeUrl("https://example.com/a?id=2&page=1")).toBe(canonicalizeUrl("https://example.com/a?page=1&id=2"));
  });

  it("assigns syndicated copies and link posts to the same story", () => {
    const first = assignStoryKey({ defaultKey: "url:https://a.com/1", title: "Startup layoffs hit three more fintech companies - Wire", recent: [] });
    const copy = assignStoryKey({ defaultKey: "url:https://b.com/9", title: "Startup Layoffs Hit Three More Fintech Companies | Daily Paper", recent: [first] });
    expect(copy.storyKey).toBe(first.storyKey);
    const link = assignStoryKey({ defaultKey: "reddit:t3_x", title: "Thoughts?", linkedUrl: "https://a.com/1", recent: [first] });
    expect(link.storyKey).toBe("url:https://a.com/1");
    const different = assignStoryKey({ defaultKey: "url:https://c.com/2", title: "Fintech hiring rebounds in three cities", recent: [first] });
    expect(different.storyKey).toBe("url:https://c.com/2");
    expect(titleFingerprint("Hello World - Outlet")).toBe(titleFingerprint("hello world"));
  });
});

describe("categories", () => {
  it("assigns configured categories and a low weight for off-topic subjects", () => {
    expect(assignCategory("Salary negotiation scripts").category).toBe("negotiation");
    expect(assignCategory("Seed round valuations").category).toBe("startups");
    const other = assignCategory("Celebrity wedding photos");
    expect(other.category).toBe("other");
    expect(other.relevance).toBeLessThan(30);
  });
});
