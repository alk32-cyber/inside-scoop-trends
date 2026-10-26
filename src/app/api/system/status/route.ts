import { systemStatus } from "@/lib/api/service";
import { handler, json } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/system/status — provider configuration, ingestion health, freshness and errors. Never returns secret values. */
export const GET = handler(async () => json(await systemStatus(), { maxAge: 10 }));
