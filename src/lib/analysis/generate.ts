import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { categories } from "../config";
import type { ScoreResult } from "../scoring/score";
import { INSUFFICIENT, ModelAnalysisSchema, type ModelAnalysis, type StoredAnalysis } from "./schema";

export interface EvidenceItem {
  id: number;
  provider: string;
  title: string;
  snippet: string | null;
  url: string;
  author: string | null;
  publishedAt: Date | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface AnalysisInput {
  topicId: string;
  name: string;
  category: string;
  score: Pick<ScoreResult, "trendScore" | "confidence" | "lifecycle" | "lifecycleReason" | "components" | "independentSources" | "perSource" | "flags">;
  evidence: EvidenceItem[];
  dataTimestamp: Date;
  isDemo: boolean;
}

/** Minimum support before any "why it is trending" narrative is attempted. */
export const MIN_EVIDENCE_ITEMS = 3;
export const MIN_CONFIDENCE_FOR_ANALYSIS = 30;

export function analysisModel(env: Record<string, string | undefined> = process.env): string {
  return env.ANALYSIS_MODEL ?? "claude-opus-5-5";
}

export function llmConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

const SYSTEM = `You write research notes for Inside Scoop, a podcast about entrepreneurship and business for a Gen Z audience.
You are given a trending topic, the metrics a scoring system measured, and the evidence items (titles, snippets, links) behind it.

Rules:
- Use only the supplied evidence and metrics. Do not add events, statistics, quotations, dates, company names or causes that are not in them.
- Every confirmed fact must cite one or more evidence URLs exactly as supplied. If you cannot cite it, it is not a confirmed fact.
- Numbers you mention must appear in the supplied metrics or evidence.
- Put plausible but unproven causes in potential_explanations, never in why_rising or confirmed_facts.
- If the evidence does not show why attention is rising, set evidence_sufficient to false and set why_rising to exactly: "${INSUFFICIENT}"
- Describe measured growth as growth in the measured signals (posts, views, discussion, normalized search interest), not as market-wide fact. Search interest is a relative 0-100 index, not search volume.
- Give exactly three content_angles suited to a business podcast (episode, business breakdown, interview, or short-form clip), 3-5 interview_questions and 2-4 case_study_questions.`;

function pct(g: number | null): string | null {
  return g === null ? null : `${Math.round((Math.exp(g) - 1) * 100)}%`;
}

export function buildPrompt(input: AnalysisInput): string {
  const metrics = {
    trend_score_out_of_100: input.score.trendScore,
    confidence_out_of_100: input.score.confidence,
    lifecycle: input.score.lifecycle,
    lifecycle_reason: input.score.lifecycleReason,
    independent_sources_confirming_growth: input.score.independentSources,
    components: input.score.components,
    per_source: input.score.perSource.map((s) => ({
      source: s.source,
      recent_window_value: s.recent,
      baseline_window_average: s.baseline === null ? null : Math.round(s.baseline * 10) / 10,
      growth_vs_baseline: pct(s.logGrowth),
      sample_size: s.sample,
    })),
    flags: input.score.flags,
    data_timestamp_utc: input.dataTimestamp.toISOString(),
  };
  const evidence = input.evidence.map((e) => ({
    url: e.url,
    provider: e.provider,
    title: e.title,
    snippet: e.snippet?.slice(0, 280) ?? null,
    outlet_or_channel: e.author,
    published_at_utc: e.publishedAt?.toISOString() ?? null,
    views: e.views,
    likes: e.likes,
    comments: e.comments,
  }));
  return `Topic: ${input.name}\nCategory: ${input.category}\n\nMeasured metrics (JSON):\n${JSON.stringify(metrics, null, 2)}\n\nEvidence items (JSON):\n${JSON.stringify(evidence, null, 2)}`;
}

/** Collects every number that appears in the inputs, in a few common renderings. */
function knownNumbers(input: AnalysisInput, prompt: string): Set<string> {
  const set = new Set<string>();
  for (const m of prompt.matchAll(/\d[\d,]*(\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, "");
    set.add(raw);
    const n = Number(raw);
    if (Number.isFinite(n)) {
      set.add(String(Math.round(n)));
      if (n >= 1000) set.add(`${Math.round(n / 1000)}k`);
      if (n >= 1e6) set.add(`${Math.round(n / 1e6)}m`);
    }
  }
  for (let i = 0; i <= 10; i++) set.add(String(i)); // small counting words like "three angles" / "2 sources"
  return set;
}

/**
 * Enforces the evidence rules after generation: URLs must come from the evidence
 * set, uncited facts are dropped, and numbers absent from the inputs are flagged.
 */
export function validateAnalysis(model: ModelAnalysis, input: AnalysisInput, prompt: string): { analysis: ModelAnalysis; validation: StoredAnalysis["validation"] } {
  const allowed = new Set(input.evidence.map((e) => e.url));
  let removedUrls = 0;
  const keepUrls = (urls: string[]) =>
    urls.filter((u) => {
      const ok = allowed.has(u);
      if (!ok) removedUrls++;
      return ok;
    });
  const facts = model.confirmed_facts.map((f) => ({ ...f, evidence_urls: keepUrls(f.evidence_urls) }));
  const cited = facts.filter((f) => f.evidence_urls.length > 0);
  const signals = model.strongest_signals.map((s) => ({ ...s, evidence_urls: keepUrls(s.evidence_urls) }));

  const known = knownNumbers(input, prompt);
  const text = [model.description, model.why_rising, model.recent_developments, ...cited.map((f) => f.statement), ...signals.map((s) => s.signal)].join(" ");
  const unverified = [...new Set([...text.matchAll(/\d[\d,]*(\.\d+)?\s*(%|k|m|x)?/gi)].map((m) => m[0].trim()))].filter((tok) => {
    const bare = tok.replace(/[,\s]/g, "").replace(/(%|x)$/i, "").toLowerCase();
    return !known.has(bare) && !known.has(bare.replace(/(k|m)$/, ""));
  });

  const notes: string[] = [];
  if (model.content_angles.length !== 3) notes.push(`model returned ${model.content_angles.length} content angles; expected 3`);
  const evidenceSufficient = model.evidence_sufficient && cited.length > 0;
  if (model.evidence_sufficient && cited.length === 0) notes.push("no fact survived citation checks; marked evidence as insufficient");

  return {
    analysis: {
      ...model,
      evidence_sufficient: evidenceSufficient,
      why_rising: evidenceSufficient ? model.why_rising : INSUFFICIENT,
      confirmed_facts: cited,
      strongest_signals: signals,
      content_angles: model.content_angles.slice(0, 3),
    },
    validation: { removed_uncited_facts: facts.length - cited.length, removed_unknown_urls: removedUrls, unverified_numbers: unverified, notes },
  };
}

function sourceLinks(input: AnalysisInput): StoredAnalysis["source_links"] {
  return input.evidence.map((e) => ({ title: e.title, url: e.url, provider: e.provider, published_at: e.publishedAt?.toISOString() ?? null }));
}

const SOURCE_LABEL: Record<string, string> = {
  youtube: "YouTube",
  reddit: "Reddit",
  news: "news coverage",
  google_trends: "Google search interest",
  demo_youtube: "YouTube (demo)",
  demo_reddit: "Reddit (demo)",
  demo_news: "news (demo)",
  demo_google_trends: "search interest (demo)",
};

/**
 * Deterministic analysis built only from measured metrics and evidence titles.
 * Used when no language model is configured, when evidence is too thin, or when the model declines.
 */
export function templateAnalysis(input: AnalysisInput, reason: string): StoredAnalysis {
  const cat = categories.find((c) => c.id === input.category)?.label ?? "Business";
  const growing = input.score.perSource.filter((s) => s.growing && s.logGrowth !== null);
  const sufficient = input.evidence.length >= MIN_EVIDENCE_ITEMS && growing.length > 0;
  const signals = growing.map((s) => ({
    signal: `${SOURCE_LABEL[s.source] ?? s.source}: recent window up ${pct(s.logGrowth)} vs its own baseline (sample of ${s.sample})`,
    source: s.source,
    evidence_urls: input.evidence.filter((e) => e.provider === s.source).slice(0, 3).map((e) => e.url),
  }));
  const facts = input.evidence.slice(0, 5).map((e) => ({
    statement: `${e.author ? `${e.author} published` : "Published"}: "${e.title}"${e.publishedAt ? ` (${e.publishedAt.toISOString().slice(0, 10)})` : ""}.`,
    evidence_urls: [e.url],
  }));
  return {
    evidence_sufficient: false,
    description: `${input.name} — a ${cat.toLowerCase()} topic detected in ${input.evidence.length} collected item(s).`,
    why_rising: sufficient
      ? `Measured attention is rising (${signals.map((s) => s.signal).join("; ")}). The underlying cause has not been analysed (${reason}).`
      : INSUFFICIENT,
    strongest_signals: signals,
    recent_developments: input.evidence.length ? `Most recent collected items: ${input.evidence.slice(0, 3).map((e) => `"${e.title}"`).join("; ")}.` : "No evidence items collected yet.",
    confirmed_facts: facts,
    potential_explanations: [],
    content_angles: [
      { title: `What's behind the ${input.name} buzz?`, format: "episode", angle: `Walk through the collected coverage and what it means for young founders in ${cat.toLowerCase()}.` },
      { title: `${input.name}: business breakdown`, format: "business breakdown", angle: "Who makes money here, how, and what it costs to get started." },
      { title: `Hot take: is ${input.name} worth your time?`, format: "short", angle: "A 60-second opinion clip that points listeners to the full episode." },
    ],
    interview_questions: [
      `How did you first notice ${input.name} picking up?`,
      `What would a 20-year-old need to start with ${input.name} on a small budget?`,
      `What are people getting wrong about ${input.name}?`,
    ],
    case_study_questions: [`Which company or creator is best positioned around ${input.name}, and why?`, "What would have to be true for this to last beyond the current spike?"],
    method: "template",
    model: null,
    data_timestamp: input.dataTimestamp.toISOString(),
    generated_at: new Date().toISOString(),
    source_links: sourceLinks(input),
    validation: { removed_uncited_facts: 0, removed_unknown_urls: 0, unverified_numbers: [], notes: [`template analysis: ${reason}`] },
    is_demo: input.isDemo,
  };
}

/**
 * Generates the analysis for one topic. The model only summarizes the supplied
 * evidence; output is schema-validated by the SDK and post-validated here.
 */
export async function generateAnalysis(input: AnalysisInput, env: Record<string, string | undefined> = process.env, client?: Anthropic): Promise<StoredAnalysis> {
  if (input.isDemo) return templateAnalysis(input, "demo data is never sent to the language model");
  if (input.evidence.length < MIN_EVIDENCE_ITEMS) return templateAnalysis(input, `only ${input.evidence.length} evidence item(s); at least ${MIN_EVIDENCE_ITEMS} required`);
  if (input.score.confidence < MIN_CONFIDENCE_FOR_ANALYSIS) return templateAnalysis(input, `confidence ${input.score.confidence} is below ${MIN_CONFIDENCE_FOR_ANALYSIS}`);
  if (!llmConfigured(env)) return templateAnalysis(input, "no ANTHROPIC_API_KEY configured");

  const anthropic = client ?? new Anthropic();
  const model = analysisModel(env);
  const prompt = buildPrompt(input);
  let response;
  try {
    response = await anthropic.beta.messages.parse({
      model,
      max_tokens: 16000,
      // Server-side fallback: if the model declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(ModelAnalysisSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return templateAnalysis(input, "language model rate limited; will retry next run");
    if (err instanceof Anthropic.APIConnectionError) return templateAnalysis(input, "language model unreachable; will retry next run");
    if (err instanceof Anthropic.APIError) return templateAnalysis(input, `language model error (HTTP ${err.status ?? "?"})`);
    throw err;
  }
  if (response.stop_reason === "refusal") return templateAnalysis(input, "language model declined this request");
  if (response.stop_reason === "max_tokens" || !response.parsed_output) return templateAnalysis(input, "language model output was incomplete");

  const { analysis, validation } = validateAnalysis(response.parsed_output, input, prompt);
  return {
    ...analysis,
    method: "llm",
    model: response.model,
    data_timestamp: input.dataTimestamp.toISOString(),
    generated_at: new Date().toISOString(),
    source_links: sourceLinks(input),
    validation,
    is_demo: false,
  };
}
