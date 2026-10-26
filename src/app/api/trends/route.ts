import { cached, isDemoMode, listTrends, TrendsQuery } from "@/lib/api/service";
import { handler, json, queryObject } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/trends — ranked topics. Filters: view, category, source, lifecycle, minConfidence, window|from|to, limit, offset. */
export const GET = handler(async (req: Request) => {
  const q = TrendsQuery.parse(queryObject(req));
  const data = await cached(`trends:${isDemoMode()}:${JSON.stringify(q)}`, () => listTrends(q));
  return json(data);
});
