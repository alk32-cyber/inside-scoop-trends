/**
 * Optional embedding provider for semantic topic merging (Voyage AI).
 * When VOYAGE_API_KEY is unset, grouping uses the deterministic rules only.
 */

export function embeddingsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.VOYAGE_API_KEY);
}

export async function embedTexts(texts: string[], env: Record<string, string | undefined> = process.env): Promise<number[][]> {
  if (!env.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set");
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 128) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: texts.slice(i, i + 128), model: env.EMBEDDING_MODEL ?? "voyage-3.5", input_type: "document" }),
    });
    if (!res.ok) throw new Error(`Voyage embeddings failed: HTTP ${res.status}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    for (const d of [...json.data].sort((a, b) => a.index - b.index)) out.push(d.embedding);
  }
  return out;
}
