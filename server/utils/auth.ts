import type { H3Event } from "h3";
import { createError, getHeader } from "h3";
import { rateLimit } from "./rateLimit";
import { safeEqual } from "./tokens";

/**
 * The edit token travels in the Authorization header (NOT the URL path), so it
 * stays out of server/platform logs and the Referer. Absent token → 401;
 * an unresolvable token → 404 at the repo layer (never 403 — no existence oracle).
 */
export function requireEditToken(event: H3Event): string {
  const header = getHeader(event, "authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw createError({ statusCode: 401, statusMessage: "Missing edit capability" });
  return token;
}

/**
 * Gate an admin-only endpoint on GEAR_ADMIN_TOKEN: throttle the gate
 * (brute-force defense on top of the constant-time compare, budget from
 * RATE_LIMITS) → constant-time compare the `x-admin-token` header. A miss (or an
 * unset server token) throws 404 — never 403 — so the route reveals nothing
 * about whether it exists. Body-size caps live at the read site
 * (readJsonBodyCapped, which measures actual bytes) — a Content-Length check
 * here would be client-supplied and spoofable.
 */
export async function requireAdmin(event: H3Event): Promise<void> {
  await rateLimit(event, "admin");
  const provided = getHeader(event, "x-admin-token");
  if (!safeEqual(provided, process.env.GEAR_ADMIN_TOKEN))
    throw createError({ statusCode: 404, statusMessage: "Not found" });
}
