import type { H3Event } from "h3";
import { adminTokenOk } from "./auth";
import { bearerToken, notFound } from "./http";
import { rateLimit } from "./rateLimit";
import { safeEqual } from "./tokens";

/**
 * Gate a cron route on either credential it accepts: `Authorization: Bearer
 * $CRON_SECRET` (Vercel auto-sends it to cron routes) or `x-admin-token:
 * $GEAR_ADMIN_TOKEN` (manual runs). Throttled on the shared "admin" budget
 * BEFORE the compares — these routes accept the same admin secret requireAdmin
 * protects, so they get the same brute-force defense (Vercel's once-a-day cron
 * never approaches the budget) — then constant-time compared so neither secret
 * leaks a matching-prefix length via timing. A miss (or unset server secrets)
 * throws 404 — never 403 — so the route reveals nothing about whether it exists.
 */
export async function requireCronAuth(event: H3Event): Promise<void> {
  await rateLimit(event, "admin");
  const ok = safeEqual(bearerToken(event), process.env.CRON_SECRET) || adminTokenOk(event);
  if (!ok) throw notFound();
}
