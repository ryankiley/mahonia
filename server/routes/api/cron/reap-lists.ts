import { defineEventHandler, setHeader } from "h3";
import { requireCronAuth } from "../../../utils/cronAuth";
import { useDb } from "../../../utils/db";
import { purgeDeletedLists, reapAbandonedLists } from "../../../utils/listRepo";
import { refreshStaleFavicons } from "../../../utils/trailFavicon";

// Nightly list-maintenance job (registered in vercel.json). Three stages:
//   1. REAP  — soft-delete abandoned lists (<= 1 item, untouched for
//              LIST_REAP_STALE_DAYS; publish status deliberately not a factor —
//              see reapAbandonedLists in server/utils/listRepo.ts) so the table
//              can't be padded indefinitely with contentless rows.
//   2. PURGE — hard-delete rows soft-deleted past LIST_PURGE_GRACE_DAYS (+ their
//              snapshots) to reclaim the storage; the grace window keeps a reap
//              reversible until then.
//   3. FAVICONS — re-fetch trail-link favicons older than a month, oldest first and
//              batch-capped (see server/utils/trailFavicon.ts). Rides along here
//              rather than as its own vercel.json entry: the Hobby tier allows two
//              cron jobs and both are already spoken for, and this is list
//              maintenance by any reasonable reading of the name.
// Auth: requireCronAuth — Bearer $CRON_SECRET (Vercel) or x-admin-token for a
// manual run; rate-limited, 404 otherwise.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await requireCronAuth(event);

  const db = await useDb();
  const reaped = await reapAbandonedLists(db);
  const purged = await purgeDeletedLists(db);
  // outbound fetches to third-party hosts — never let a slow or dead one fail the
  // whole maintenance run, which is what keeps the reap/purge above meaningful
  const favicons = await refreshStaleFavicons(db).catch((e) => {
    console.warn("[cron] favicon refresh failed", (e as Error).message);
    return { checked: 0, updated: 0 };
  });
  const result = { ...reaped, ...purged, favicons };
  console.log("[cron] reap-lists", JSON.stringify(result));
  return { ok: true, ...result };
});
