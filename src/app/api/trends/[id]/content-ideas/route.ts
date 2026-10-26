import { cached, getContentIdeas, isDemoMode, TopicId } from "@/lib/api/service";
import { errorResponse, handler, json } from "@/lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/trends/:id/content-ideas — evidence-grounded analysis and episode angles. */
export const GET = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const id = TopicId.parse((await ctx.params).id);
  const data = await cached(`ideas:${isDemoMode()}:${id}`, () => getContentIdeas(id));
  return data ? json(data) : errorResponse(404, "not_found", `No topic "${id}"`);
});
