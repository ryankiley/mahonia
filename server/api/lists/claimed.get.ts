import { defineEventHandler } from "h3";
import { requireAccount } from "../../utils/authSession";
import { listClaimedLists } from "../../utils/claimRepo";

// The lists attached to this account. Each carries its SHARE CODE as the handle,
// never an edit token — a claimed list is opened by naming it and proving the
// session, not by being handed a capability back (see utils/editAuth).
//
// `private, no-store`: this is one person's list of lists.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "list-claim");
  return { lists: await listClaimedLists(db, user.id) };
});
