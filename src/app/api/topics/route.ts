import { cached, isDemoMode, listPodTopics, PodQuery } from "@/lib/api/service";
import { handler, json, queryObject } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/topics — topics ranked for a teen business podcast. Query: lane, sort (best|newest|rising), limit, offset. */
export const GET = handler(async (req: Request) => {
  const q = PodQuery.parse(queryObject(req));
  const data = await cached(`pod:${isDemoMode()}:${JSON.stringify(q)}`, () => listPodTopics(q));
  return json(data);
});
