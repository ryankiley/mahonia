import { createError, defineEventHandler, getHeader, setHeader } from "h3";
import { useDb } from "../../../utils/db";
import { reapAbandonedLists } from "../../../utils/listRepo";
import { safeEqual } from "../../../utils/tokens";

// Nightly maintenance job (registered in vercel.json). Soft-deletes abandoned
// empty lists (0 items, never public, untouched for LIST_REAP_STALE_DAYS) so the
// table can't be padded indefinitely with contentless rows.
// Auth mirrors the corroborate-catalog cron: Vercel auto-sends
// `Authorization: Bearer $CRON_SECRET` to cron routes; `x-admin-token:
// $GEAR_ADMIN_TOKEN` also works for a manual run. 404 otherwise.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  const cronSecret = process.env.CRON_SECRET;
  const adminToken = process.env.GEAR_ADMIN_TOKEN;
  const auth = getHeader(event, "authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const admin = getHeader(event, "x-admin-token") || "";
  // constant-time compare so neither secret leaks a matching-prefix length via timing
  const ok = safeEqual(bearer, cronSecret) || safeEqual(admin, adminToken);
  if (!ok) throw createError({ statusCode: 404, statusMessage: "Not found" });

  const db = await useDb();
  const result = await reapAbandonedLists(db);
  console.log("[cron] reap-lists", JSON.stringify(result));
  return { ok: true, ...result };
});
