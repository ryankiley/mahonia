import { defineEventHandler } from "h3";
import { requireAccount } from "../../utils/authSession";
import {
  CLAIM_BATCH_MAX,
  backfillVaultFromClaims,
  claimLists,
  listClaimedLists,
} from "../../utils/claimRepo";
import { useVaultDb } from "../../utils/db";
import { readJsonBodyCapped } from "../../utils/http";

// Attach the lists this browser holds to the signed-in account, so they're there
// on the next device too.
//
// The client posts the edit tokens from its local "Your lists" registry. They're
// resolved and dropped — only (user, list) is stored, so this endpoint receives
// capabilities but never records them. See server/utils/claimRepo.ts.
//
// Idempotent: claiming an already-claimed list is a no-op, so the client can call
// this on every sign-in and after every list it creates without bookkeeping.
// Returns the account's full claimed set so the caller can render immediately
// without a second round-trip.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "list-claim");

  const body = await readJsonBodyCapped<{ editTokens?: unknown; openedTokens?: unknown }>(
    event,
    64_000,
  );
  const tokenList = (v: unknown) =>
    Array.isArray(v) ? (v.filter((t) => typeof t === "string") as string[]).slice(0, CLAIM_BATCH_MAX) : [];
  const editTokens = tokenList(body?.editTokens);
  // The lists this browser says arrived via someone else's link. Sent so the SERVER
  // can judge them — it knows when each list was made, and the browser doesn't —
  // but claimed only under claimLists' narrower rule, never on the say-so of being
  // in this array.
  const openedTokens = tokenList(body?.openedTokens);

  // useVaultDb as well as the account db: the backfill below writes vault rows, and
  // on Neon the vault tables are ensured on first use rather than migrated. Without
  // this the write would throw into the swallowed catch and the backfill would
  // silently never happen on a cold instance.
  await useVaultDb();
  const claimed =
    editTokens.length || openedTokens.length
      ? await claimLists(db, user.id, editTokens, openedTokens)
      : 0;

  // Rebuild the vault from every list this account holds, not just the ones that
  // happen to get opened. Without this, signing in on a new device shows your
  // lists but a vault that only knows the gear you've edited since — which isn't
  // what "all my gear, anywhere I sign in" should mean. Idempotent and
  // tombstone-safe (see backfillVaultFromClaims), and never allowed to fail the
  // claim it rode in on.
  await backfillVaultFromClaims(db, user.id).catch((e) => {
    console.error("[vault backfill]", e);
  });

  return { claimed, lists: await listClaimedLists(db, user.id) };
});
