import { defineEventHandler } from "h3";
import { requireCron } from "../../../utils/auth";
import { useAccountDb, useDb, useVaultDb } from "../../../utils/db";
import { purgeDeletedLists, reapAbandonedLists } from "../../../utils/listRepo";
import { purgeDeletedVaults, reapAbandonedVaults } from "../../../utils/vaultRepo";
import { refreshStaleFavicons } from "../../../utils/trailFavicon";
import { setNoIndex } from "../../../utils/http";

// Nightly list-maintenance job (registered in vercel.json). Three stages:
//   1. REAP  — soft-delete abandoned lists (<= 1 item, untouched for
//              LIST_REAP_STALE_DAYS; see reapAbandonedLists in
//              server/utils/listRepo.ts) so the table
//              can't be padded indefinitely with contentless rows.
//   2. PURGE — hard-delete rows soft-deleted past LIST_PURGE_GRACE_DAYS (+ their
//              snapshots and the claims accounts held on them) to reclaim the
//              storage; the grace window keeps a reap reversible until then.
//   3. VAULTS — the same two stages for the vaults NO account owns (the link-owned
//              ones from before My Gear moved into an account), which nothing can
//              open any more. An account's vault is never reaped or purged; see
//              reapAbandonedVaults in server/utils/vaultRepo.ts.
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
// land at once. Harmless today (they touch different tables, and the shared "cron"
// rate-limit budget is 30/min against two requests), but don't add work here that
// assumes the catalog job has already finished.
// Auth: requireCron, Bearer $CRON_SECRET (Vercel sends it; a manual run sends the
// same); rate-limited, 404 otherwise.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await requireCron(event);

  const db = await useDb();
  const reaped = await reapAbandonedLists(db);
  // The purge drops the purged lists' claims, and list_claims is the account layer's
  // table, made on first use: asked for here so a cold instance has it to delete from.
  // Like the vault stage below it must not be able to fail list maintenance: if the
  // account schema can't be ensured the purge still runs, and skips only the claims
  // (purgeDeletedLists).
  await useAccountDb().catch((e) => {
    console.warn("[cron] account schema not ensured", (e as Error).message);
  });
  const purged = await purgeDeletedLists(db);
  // Vault maintenance must not be able to fail list maintenance: the vault schema
  // is ensured on first use, so a run that touches it before any vault exists is
  // the one place this can throw, and losing the reap/purge above to it would be a
  // poor trade for a table that only grows slowly. The ensure is inside the try for
  // that reason: it is the step that throws, and a failure there costs this stage only.
  let vaultMaint = { vaultsReaped: 0, vaultsPurged: 0 };
  try {
    const vaultsDb = await useVaultDb();
    vaultMaint = { ...(await reapAbandonedVaults(vaultsDb)), ...(await purgeDeletedVaults(vaultsDb)) };
  } catch (e) {
    console.warn("[cron] vault maintenance failed", (e as Error).message);
  }
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
