import { getDb, isEphemeralDb, persistLive, storageMode } from "@/lib/db";
import { runPipeline } from "@/lib/pipeline/run";
import { clearCache } from "@/lib/api/service";
import { errorResponse, handler, json } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled ingestion entry point (Vercel Cron or any scheduler).
 * Requires `Authorization: Bearer $CRON_SECRET`. Runs only providers that are due,
 * unless ?force=1; ?provider=youtube,reddit limits the run.
 */
export const GET = handler(async (req: Request) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return errorResponse(503, "cron_disabled", "CRON_SECRET is not configured");
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return errorResponse(401, "unauthorized", "Invalid cron credentials");
  // Collected data would vanish with the serverless instance; refuse rather than pretend to store it.
  if (isEphemeralDb()) return errorResponse(503, "no_persistent_database", "Connect Postgres (DATABASE_URL) or a Vercel Blob store (BLOB_READ_WRITE_TOKEN) before running live ingestion on this host.");
  const url = new URL(req.url);
  const list = url.searchParams.get("provider")?.split(",").filter(Boolean);
  // Blob mode: start from the newest saved snapshot, then save the result back.
  const db = await getDb({ fresh: true });
  const report = await runPipeline(db, { providers: list, force: url.searchParams.get("force") === "1" });
  const saved = await persistLive(db);
  clearCache();
  return json(
    {
      runs: report.runs.map((r) => ({ provider: r.provider, status: r.status, itemsFetched: r.itemsFetched, itemsNew: r.itemsNew, requests: r.requestsMade, error: r.error ?? null })),
      observationsWritten: report.observationsWritten,
      topicsScored: report.scored,
      analyses: report.analyses,
      storage: storageMode(),
      savedBytes: saved?.bytes ?? null,
    },
    { maxAge: 0 },
  );
});
