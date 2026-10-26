import { NextResponse, type NextRequest } from "next/server";

/**
 * Access control + basic rate limiting.
 * - DASHBOARD_PASSWORD set: every page and API route requires HTTP Basic auth (any username).
 * - /api/cron/* authenticates with CRON_SECRET inside the route instead.
 * - API_RATE_LIMIT_PER_MINUTE (default 120) per client IP, per server instance (best effort).
 */
const buckets = new Map<string, { tokens: number; at: number }>();

function rateLimited(ip: string): boolean {
  const limit = Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 120);
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: limit, at: now };
  b.tokens = Math.min(limit, b.tokens + ((now - b.at) / 60_000) * limit);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return true;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  if (buckets.size > 10_000) buckets.clear();
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/cron/")) return NextResponse.next();

  if (path.startsWith("/api/")) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    if (rateLimited(ip)) return NextResponse.json({ error: { code: "rate_limited", message: "Too many requests" } }, { status: 429, headers: { "Retry-After": "30" } });
  }

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const supplied = decoded.slice(decoded.indexOf(":") + 1);
    if (timingSafeEqual(supplied, password)) return NextResponse.next();
  }
  return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Inside Scoop Trends"' } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
