import { defineEventHandler } from "h3";
import { requireUser } from "../../utils/authSession";
import { listClaimedLists } from "../../utils/claimRepo";
import { useAccountDb } from "../../utils/db";
import { rateLimit } from "../../utils/rateLimit";
import { setNoIndex, setPrivate } from "../../utils/http";

// The lists attached to this account. Each carries its SHARE CODE as the handle,
// never an edit token — a claimed list is opened by naming it and proving the
// session, not by being handed a capability back (see utils/editAuth).
//
// `private, no-store`: this is one person's list of lists.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "list-claim");
  const user = await requireUser(event);
  const db = await useAccountDb();
  return { lists: await listClaimedLists(db, user.id) };
});
