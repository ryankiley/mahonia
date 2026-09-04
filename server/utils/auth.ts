import type { H3Event } from "h3";
import { getHeader } from "h3";
import { bearerToken, notFound } from "./http";
import { rateLimit } from "./rateLimit";
import { safeEqual } from "./tokens";

/**
 * Gate an admin-only endpoint on GEAR_ADMIN_TOKEN: throttle the gate
 * (brute-force defense on top of the constant-time compare, budget from
 * RATE_LIMITS) → constant-time compare the `x-admin-token` header. A miss (or an
 * unset server token) throws 404 — never 403 — so the route reveals nothing
 * about whether it exists. Body-size caps live at the read site
 * (readJsonBodyCapped, which measures actual bytes) — a Content-Length check
 * here would be client-supplied and spoofable.
 *
 * `orBearer` is the cron routes' second door: `Authorization: Bearer
 * $CRON_SECRET`, which Vercel auto-sends to cron routes, alongside the admin
 * header for manual runs. Those routes accept the same admin secret this gate
 * protects, so they get the same brute-force defense (Vercel's once-a-day cron
 * never approaches the budget), and both secrets are constant-time compared so
 * neither leaks a matching-prefix length via timing. An unset CRON_SECRET simply
 * never matches (safeEqual refuses a falsy side).
 */
export async function requireAdmin(event: H3Event, opts?: { orBearer?: string }): Promise<void> {
  await rateLimit(event, "admin");
  const provided = getHeader(event, "x-admin-token");
  const ok =
    safeEqual(provided, process.env.GEAR_ADMIN_TOKEN) ||
    safeEqual(bearerToken(event), opts?.orBearer);
  if (!ok) throw notFound();
}
