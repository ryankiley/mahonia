import { defineEventHandler } from "h3";
import { endAllSessions, requireAccount } from "../../utils/authSession";

// Sign out everywhere — the answer to "I think someone else is in my account".
//
// Separate from /signout because it does a different thing: that one drops the
// cookie you're holding, this one invalidates every session the account has on
// every device. Requires a live session, so it's an action only the account holder
// can take, and it takes the caller's own session with it (see endAllSessions).
//
// POST, like signout, so a prefetched link or a cross-site <img> can't trigger it.
export default defineEventHandler(async (event) => {
  const { user } = await requireAccount(event, "account");
  const ended = await endAllSessions(event, user.id);
  return { ok: true as const, ended };
});
