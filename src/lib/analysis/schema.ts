import { z } from "zod";

/** What the language model must return. Validated by the SDK (structured outputs) and again here. */
export const ModelAnalysisSchema = z.object({
  evidence_sufficient: z.boolean().describe("False when the evidence does not show why attention is rising."),
  description: z.string().describe("One or two sentences: what the topic is."),
  why_rising: z
    .string()
    .describe("Evidence-based explanation citing the supplied signals. If evidence is insufficient: 'The reason for this trend cannot yet be confirmed.'"),
  strongest_signals: z.array(z.object({ signal: z.string(), source: z.string(), evidence_urls: z.array(z.string()) })),
  recent_developments: z.string().describe("Summary of developments that appear in the supplied evidence only."),
  confirmed_facts: z.array(z.object({ statement: z.string(), evidence_urls: z.array(z.string()) })),
  potential_explanations: z.array(z.object({ hypothesis: z.string(), what_would_confirm_it: z.string() })),
  content_angles: z.array(z.object({ title: z.string(), format: z.string(), angle: z.string() })),
  interview_questions: z.array(z.string()),
  case_study_questions: z.array(z.string()),
});
export type ModelAnalysis = z.infer<typeof ModelAnalysisSchema>;

/** What is stored in content_recommendations.payload and served by the API. */
export const StoredAnalysisSchema = ModelAnalysisSchema.extend({
  method: z.enum(["llm", "template"]),
  model: z.string().nullable(),
  data_timestamp: z.string(),
  generated_at: z.string(),
  source_links: z.array(z.object({ title: z.string(), url: z.string(), provider: z.string(), published_at: z.string().nullable() })),
  validation: z.object({
    removed_uncited_facts: z.number(),
    removed_unknown_urls: z.number(),
    unverified_numbers: z.array(z.string()),
    notes: z.array(z.string()),
  }),
  is_demo: z.boolean(),
});
export type StoredAnalysis = z.infer<typeof StoredAnalysisSchema>;

export const INSUFFICIENT = "The reason for this trend cannot yet be confirmed from the collected evidence.";
