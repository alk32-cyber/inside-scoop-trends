import { cached, getTrend, isDemoMode, TopicId } from "@/lib/api/service";
import { errorResponse, handler, json } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/trends/:id — metadata, score breakdown, history, activity chart data, evidence links. */
export const GET = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const id = TopicId.parse((await ctx.params).id);
  const data = await cached(`trend:${isDemoMode()}:${id}`, () => getTrend(id));
  return data ? json(data) : errorResponse(404, "not_found", `No scored topic "${id}"`);
});
