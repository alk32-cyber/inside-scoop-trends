import { NextResponse } from "next/server";
import { z } from "zod";

export function json(data: unknown, init: { status?: number; maxAge?: number } = {}) {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    // Private: responses may sit behind dashboard auth. Short max-age; the server also caches.
    headers: { "Cache-Control": `private, max-age=${init.maxAge ?? 30}, stale-while-revalidate=60` },
  });
}

export function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json({ error: { code, message, details } }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Wraps a handler with uniform validation and error handling. Internal errors never leak stack traces. */
export function handler<C>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof z.ZodError) return errorResponse(400, "invalid_request", "Invalid query parameters", z.flattenError(err).fieldErrors);
      console.error("[api]", err);
      return errorResponse(500, "internal_error", "Something went wrong while reading trend data.");
    }
  };
}

export function queryObject(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}
