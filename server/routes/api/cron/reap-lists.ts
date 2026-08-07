import { defineEventHandler, setHeader } from "h3";
import { requireCronAuth } from "../../../utils/cronAuth";
import { useDb, useVaultDb } from "../../../utils/db";
import { purgeDeletedLists, reapAbandonedLists } from "../../../utils/listRepo";
import { purgeDeletedVaults, reapAbandonedVaults } from "../../../utils/vaultRepo";
import { refreshStaleFavicons } from "../../../utils/trailFavicon";

// Nightly list-maintenance job (registered in vercel.json). Three stages:
//   1. REAP  — soft-delete abandoned lists (<= 1 item, untouched for
//              LIST_REAP_STALE_DAYS; publish status deliberately not a factor —
//              see reapAbandonedLists in server/utils/listRepo.ts) so the table
//              can't be padded indefinitely with contentless rows.
//   2. PURGE — hard-delete rows soft-deleted past LIST_PURGE_GRACE_DAYS (+ their
//              snapshots) to reclaim the storage; the grace window keeps a reap
//              reversible until then.
//   3. VAULTS — the same two stages for vaults, which are minted lazily and
//              never signed out of, so nothing else would ever bound their growth.
//              Longer
//              windows than a list gets; see reapAbandonedVaults for why, and for
//              why using a link inside the grace revives the vault.
//   4. FAVICONS — re-fetch trail-link favicons older than a month, oldest first and
//              batch-capped (see server/utils/trailFavicon.ts). Rides along here
//              rather than as its own vercel.json entry because it IS list
//              maintenance by any reasonable reading of the name — NOT for want of
//              cron budget. (It used to be: Hobby allowed two cron jobs per team and
//              both were spoken for. That cap was lifted in Jan 2026 — per-project
//              limits are now 100 on every plan — so splitting this out is available
//              if it ever earns its own entry.)
// Scheduling: what Hobby still constrains is FREQUENCY, not count — once a day, and
// Vercel may fire the job anywhere inside the scheduled hour. So the 20-minute gap
// from corroborate-catalog in vercel.json is a nicety, not a guarantee: both jobs can
// land at once. Harmless today (they touch different tables, and the shared "admin"
// rate-limit budget is 30/min against two requests), but don't add work here that
// assumes the catalog job has already finished.
// Auth: requireCronAuth — Bearer $CRON_SECRET (Vercel) or x-admin-token for a
// manual run; rate-limited, 404 otherwise.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await requireCronAuth(event);

  const db = await useDb();
  const reaped = await reapAbandonedLists(db);
  const purged = await purgeDeletedLists(db);
  // Vault maintenance must not be able to fail list maintenance: the vault schema
  // is ensured on first use, so a run that touches it before any vault exists is
  // the one place this can throw, and losing the reap/purge above to it would be a
  // poor trade for a table that only grows slowly.
  const vaultsDb = await useVaultDb();
  const vaultMaint = await (async () => ({
    ...(await reapAbandonedVaults(vaultsDb)),
    ...(await purgeDeletedVaults(vaultsDb)),
  }))().catch((e) => {
    console.warn("[cron] vault maintenance failed", (e as Error).message);
    return { vaultsReaped: 0, vaultsPurged: 0 };
  });
  // outbound fetches to third-party hosts — never let a slow or dead one fail the
  // whole maintenance run, which is what keeps the reap/purge above meaningful
  const favicons = await refreshStaleFavicons(db).catch((e) => {
    console.warn("[cron] favicon refresh failed", (e as Error).message);
    return { checked: 0, updated: 0 };
  });
  const result = { ...reaped, ...purged, ...vaultMaint, favicons };
  console.log("[cron] reap-lists", JSON.stringify(result));
  return { ok: true, ...result };
});
