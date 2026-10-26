import { cached, getSources, isDemoMode, SourcesQuery, TopicId } from "@/lib/api/service";
import { errorResponse, handler, json, queryObject } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/trends/:id/sources — the original source items supporting a topic (paginated). */
export const GET = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const id = TopicId.parse((await ctx.params).id);
  const q = SourcesQuery.parse(queryObject(req));
  const data = await cached(`sources:${isDemoMode()}:${id}:${q.limit}:${q.offset}`, () => getSources(id, q));
  return data ? json(data) : errorResponse(404, "not_found", `No topic "${id}"`);
});
