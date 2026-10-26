import type { Db } from "../db";
import { loadScoringConfig, providerSchedule } from "../config";
import { providers } from "../providers";
import { analyzeTop } from "./analyze";
import { deriveObservations } from "./derive";
import { finishRun, ingestProvider, startRun, type RunRecord } from "./ingest";
import { normalizeRecent } from "./normalize";
import { scoreAll } from "./score";

/** Window of buckets rebuilt after each ingest (covers the full scoring history). */
function rebuildFrom(now: Date): Date {
  const cfg = loadScoringConfig();
  return new Date(now.getTime() - (cfg.baselineWindows + 1) * cfg.windowHours * 3600_000);
}

/** Whether a provider is due according to its configured interval (based on its last attempted run). */
export async function isDue(db: Db, provider: string, now = new Date(), env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const { intervalMinutes } = providerSchedule(provider, env);
  const [last] = await db.query<{ started_at: Date }>(
    "SELECT started_at FROM ingestion_runs WHERE provider = $1 AND job = 'ingest' AND status <> 'skipped' ORDER BY started_at DESC LIMIT 1",
    [provider],
  );
  return !last || now.getTime() - new Date(last.started_at).getTime() >= intervalMinutes * 60_000 * 0.95;
}

export interface PipelineReport {
  runs: RunRecord[];
  normalized: Awaited<ReturnType<typeof normalizeRecent>> | null;
  observationsWritten: number;
  scored: number;
  analyses: { generated: number; skipped: number };
}

/**
 * Full live pipeline: ingest (due or selected providers) -> normalize -> derive observations
 * -> score -> analyze. One failing provider never stops the others.
 */
export async function runPipeline(
  db: Db,
  opts: { providers?: string[]; force?: boolean; now?: Date; env?: Record<string, string | undefined>; analyze?: boolean } = {},
): Promise<PipelineReport> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const runs: RunRecord[] = [];
  for (const adapter of providers) {
    if (opts.providers && !opts.providers.includes(adapter.name)) continue;
    if (!opts.force && !(await isDue(db, adapter.name, now, env))) continue;
    try {
      runs.push(await ingestProvider(db, adapter, env, now));
    } catch (err) {
      // Storage errors are recorded per provider; the rest of the pipeline continues.
      const id = await startRun(db, adapter.name, "ingest", false, now);
      await finishRun(db, id, { status: "failed", error: `pipeline error: ${(err as Error).message}` });
      runs.push({ id, provider: adapter.name, status: "failed", itemsFetched: 0, itemsNew: 0, observationsWritten: 0, requestsMade: 0, warnings: [], touchedItemIds: [], touchedTopicIds: [], error: (err as Error).message });
    }
  }

  const job = await startRun(db, "pipeline", "normalize_score", false, now);
  try {
    const normalized = await normalizeRecent(db, { now });
    const active = (await db.query<{ id: string }>("SELECT id FROM topics WHERE status = 'active' AND is_demo = FALSE")).map((r) => r.id);
    const observationsWritten = await deriveObservations(db, active, rebuildFrom(now), now);
    const scored = await scoreAll(db, { asOf: now, isDemo: false });
    const analyses = opts.analyze === false ? { generated: 0, skipped: 0 } : await analyzeTop(db, scored.results, { env });
    await finishRun(db, job, { status: "success", observationsWritten, details: { normalized: { ...normalized, touchedTopicIds: normalized.touchedTopicIds.length }, scored: scored.scored, analyses } });
    return { runs, normalized, observationsWritten, scored: scored.scored, analyses };
  } catch (err) {
    await finishRun(db, job, { status: "failed", error: (err as Error).message });
    throw err;
  }
}
