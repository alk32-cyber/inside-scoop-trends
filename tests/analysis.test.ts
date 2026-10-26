import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt, generateAnalysis, validateAnalysis, type AnalysisInput } from "@/lib/analysis/generate";
import { INSUFFICIENT, StoredAnalysisSchema, type ModelAnalysis } from "@/lib/analysis/schema";
import { scoreTopic } from "@/lib/scoring/score";
import { ASOF, fullCoverage, newsPosts, series } from "./helpers";

const score = scoreTopic({ topicId: "t", relevance: 80, observations: series("news", [3, 3, 3, 3, 3, 6, 14], newsPosts) }, ASOF, undefined, { coverage: fullCoverage("news") });
const evidence = [1, 2, 3].map((i) => ({
  id: i,
  provider: "news",
  title: `Headline ${i}`,
  snippet: "Snippet",
  url: `https://example.com/${i}`,
  author: "Outlet",
  publishedAt: new Date(ASOF - i * 3600_000),
  views: null,
  likes: null,
  comments: null,
}));
const input: AnalysisInput = { topicId: "t", name: "Test topic", category: "startups", score, evidence, dataTimestamp: new Date(ASOF), isDemo: false };

const modelOut: ModelAnalysis = {
  evidence_sufficient: true,
  description: "A topic.",
  why_rising: "Coverage rose to 14 stories in the latest window.",
  strongest_signals: [{ signal: "News stories up", source: "news", evidence_urls: ["https://example.com/1", "https://made-up.example/x"] }],
  recent_developments: "Three outlets covered it.",
  confirmed_facts: [
    { statement: "Outlet reported Headline 1.", evidence_urls: ["https://example.com/1"] },
    { statement: "A $40 billion deal closed.", evidence_urls: ["https://not-in-evidence.example/"] },
  ],
  potential_explanations: [{ hypothesis: "Maybe a policy change.", what_would_confirm_it: "Official announcement" }],
  content_angles: [
    { title: "A", format: "episode", angle: "a" },
    { title: "B", format: "short", angle: "b" },
    { title: "C", format: "interview", angle: "c" },
  ],
  interview_questions: ["Q1"],
  case_study_questions: ["Q2"],
};

describe("analysis guardrails", () => {
  it("drops facts and URLs that are not in the retrieved evidence and flags invented numbers", () => {
    const { analysis, validation } = validateAnalysis(modelOut, input, buildPrompt(input));
    expect(analysis.confirmed_facts).toHaveLength(1);
    expect(validation.removed_uncited_facts).toBe(1);
    expect(analysis.strongest_signals[0].evidence_urls).toEqual(["https://example.com/1"]);
    expect(validation.removed_unknown_urls).toBe(2);
    expect(validation.unverified_numbers).toEqual([]); // "14" is in the metrics; the $40 billion fact was removed
    const invented = validateAnalysis({ ...modelOut, why_rising: "Up 73% after a 9,999 signup surge." }, input, buildPrompt(input));
    expect(invented.validation.unverified_numbers).toEqual(expect.arrayContaining(["73%", "9,999"]));
  });

  it("marks evidence insufficient when no fact survives citation checks", () => {
    const { analysis } = validateAnalysis({ ...modelOut, confirmed_facts: [{ statement: "x", evidence_urls: ["https://nope.example"] }] }, input, buildPrompt(input));
    expect(analysis.evidence_sufficient).toBe(false);
    expect(analysis.why_rising).toBe(INSUFFICIENT);
  });

  it("falls back to a labelled template without calling the model when evidence or credentials are missing", async () => {
    const thin = await generateAnalysis({ ...input, evidence: evidence.slice(0, 1) }, { ANTHROPIC_API_KEY: "x" });
    expect(thin.method).toBe("template");
    expect(thin.why_rising).toBe(INSUFFICIENT);
    const noKey = await generateAnalysis(input, {});
    expect(noKey.method).toBe("template");
    expect(noKey.validation.notes.join(" ")).toContain("no ANTHROPIC_API_KEY");
    const demo = await generateAnalysis({ ...input, isDemo: true }, { ANTHROPIC_API_KEY: "x" });
    expect(demo.method).toBe("template");
    expect(StoredAnalysisSchema.safeParse(noKey).success).toBe(true);
    expect(noKey.source_links.map((l) => l.url)).toEqual(evidence.map((e) => e.url));
    expect(noKey.data_timestamp).toBe(new Date(ASOF).toISOString());
  });

  it("uses the model's structured output, then validates it", async () => {
    const calls: unknown[] = [];
    const fake = {
      beta: {
        messages: {
          parse: async (params: unknown) => {
            calls.push(params);
            return { stop_reason: "end_turn", model: "claude-opus-5-5", parsed_output: modelOut };
          },
        },
      },
    } as unknown as Anthropic;
    const out = await generateAnalysis(input, { ANTHROPIC_API_KEY: "x" }, fake);
    expect(out.method).toBe("llm");
    expect(out.confirmed_facts).toHaveLength(1);
    expect(StoredAnalysisSchema.safeParse(out).success).toBe(true);
    const params = calls[0] as { model: string; output_config: { format: unknown } };
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config.format).toBeDefined();
  });

  it("falls back to the template when the model declines", async () => {
    const fake = { beta: { messages: { parse: async () => ({ stop_reason: "refusal", parsed_output: null, model: "m" }) } } } as unknown as Anthropic;
    const out = await generateAnalysis(input, { ANTHROPIC_API_KEY: "x" }, fake);
    expect(out.method).toBe("template");
  });
});
