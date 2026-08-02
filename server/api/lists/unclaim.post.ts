import { defineEventHandler, setHeader } from "h3";
import { requireUser } from "../../utils/authSession";
import { unclaimList } from "../../utils/claimRepo";
import { useAccountDb } from "../../utils/db";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

// "Remove from my account" — the account-level counterpart of "remove from this
// device". Drops the claim only: the list itself is untouched, and anyone holding
// its edit link (including this user, on a device that has it) can still open it.
//
// Deliberately NOT a delete. Deleting a list for everyone is a separate, louder
// action that already exists and keeps its confirmation dialog.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "list-claim");
  const user = await requireUser(event);

  const body = await readJsonBodyCapped<{ shareCode?: unknown }>(event, 2_000);
  const shareCode = typeof body?.shareCode === "string" ? body.shareCode.slice(0, 32) : "";
  if (!shareCode) return { ok: false };

  const db = await useAccountDb();
  return { ok: await unclaimList(db, user.id, shareCode) };
});
