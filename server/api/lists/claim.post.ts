import { defineEventHandler, setHeader } from "h3";
import { requireUser } from "../../utils/authSession";
import {
  CLAIM_BATCH_MAX,
  backfillVaultFromClaims,
  claimLists,
  listClaimedLists,
} from "../../utils/claimRepo";
import { useAccountDb } from "../../utils/db";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

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
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "list-claim");
  const user = await requireUser(event);

  const body = await readJsonBodyCapped<{ editTokens?: unknown }>(event, 64_000);
  const editTokens = Array.isArray(body?.editTokens)
    ? (body.editTokens.filter((t) => typeof t === "string") as string[]).slice(0, CLAIM_BATCH_MAX)
    : [];

  const db = await useAccountDb();
  const claimed = editTokens.length ? await claimLists(db, user.id, editTokens) : 0;

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
