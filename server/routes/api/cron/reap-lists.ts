import { defineEventHandler, setHeader } from "h3";
import { requireCronAuth } from "../../../utils/cronAuth";
import { useDb } from "../../../utils/db";
import { purgeDeletedLists, reapAbandonedLists } from "../../../utils/listRepo";

// Nightly list-maintenance job (registered in vercel.json). Two stages:
//   1. REAP  — soft-delete abandoned lists (<= 1 item, untouched for
//              LIST_REAP_STALE_DAYS; publish status deliberately not a factor —
//              see reapAbandonedLists in server/utils/listRepo.ts) so the table
//              can't be padded indefinitely with contentless rows.
//   2. PURGE — hard-delete rows soft-deleted past LIST_PURGE_GRACE_DAYS (+ their
//              snapshots) to reclaim the storage; the grace window keeps a reap
//              reversible until then.
// Auth: requireCronAuth — Bearer $CRON_SECRET (Vercel) or x-admin-token for a
// manual run; rate-limited, 404 otherwise.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await requireCronAuth(event);

  const db = await useDb();
  const reaped = await reapAbandonedLists(db);
  const purged = await purgeDeletedLists(db);
  const result = { ...reaped, ...purged };
  console.log("[cron] reap-lists", JSON.stringify(result));
  return { ok: true, ...result };
});
