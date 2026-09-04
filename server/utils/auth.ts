import type { H3Event } from "h3";
import { getHeader } from "h3";
import { notFound } from "./http";
import { rateLimit } from "./rateLimit";
import { safeEqual } from "./tokens";

/** Does the request carry GEAR_ADMIN_TOKEN in `x-admin-token`? Constant-time,
 *  and false when the server has no token set. The one compare behind both the
 *  admin gate below and the cron gate (cronAuth), which accepts it as the manual-
 *  run credential. */
export function adminTokenOk(event: H3Event): boolean {
  return safeEqual(getHeader(event, "x-admin-token"), process.env.GEAR_ADMIN_TOKEN);
}

/**
 * Gate an admin-only endpoint on GEAR_ADMIN_TOKEN: throttle the gate
 * (brute-force defense on top of the constant-time compare, budget from the
 * "admin" rate limit) → constant-time compare the `x-admin-token` header. A miss
 * (or an unset server token) throws 404 — never 403 — so the route reveals
 * nothing about whether it exists. Body-size caps live at the read site
 * (readJsonBodyCapped, which measures actual bytes) — a Content-Length check
 * here would be client-supplied and spoofable.
 */
export async function requireAdmin(event: H3Event): Promise<void> {
  await rateLimit(event, "admin");
  if (!adminTokenOk(event)) throw notFound();
}
