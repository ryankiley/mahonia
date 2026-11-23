import type { H3Event } from "h3";
import { bearerToken, notFound } from "./http";
import { rateLimit } from "./rateLimit";
import { safeEqual } from "./tokens";

/**
 * Gate a cron route on CRON_SECRET, which Vercel sends to cron routes as
 * `Authorization: Bearer $CRON_SECRET`; a manual run sends the same header. Throttled
 * first (brute-force defense on top of the constant-time compare; the once-a-day cron
 * never approaches the budget). A miss, or an unset CRON_SECRET (safeEqual refuses a
 * falsy side), throws 404, never 403, so the route reveals nothing about whether it
 * exists.
 *
 * The cron routes are the only ones a secret opens. What a person does as an admin goes
 * through the MCP connector, signed in as an account named in ADMIN_USER_IDS (admin.ts).
 */
export async function requireCron(event: H3Event): Promise<void> {
  await rateLimit(event, "cron");
  if (!safeEqual(bearerToken(event), process.env.CRON_SECRET)) throw notFound();
}
