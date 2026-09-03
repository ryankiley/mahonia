import { defineEventHandler } from "h3";
import { requireAccount } from "../../utils/authSession";
import { unclaimList } from "../../utils/claimRepo";
import { readJsonBodyCapped } from "../../utils/http";

// "Remove from my account" — the account-level counterpart of "remove from this
// device". Drops the claim only: the list itself is untouched, and anyone holding
// its edit link (including this user, on a device that has it) can still open it.
//
// Deliberately NOT a delete. Deleting a list for everyone is a separate, louder
// action that already exists and keeps its confirmation dialog.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "list-claim");

  const body = await readJsonBodyCapped<{ shareCode?: unknown }>(event, 2_000);
  const shareCode = typeof body?.shareCode === "string" ? body.shareCode.slice(0, 32) : "";
  if (!shareCode) return { ok: false };

  return { ok: await unclaimList(db, user.id, shareCode) };
});
