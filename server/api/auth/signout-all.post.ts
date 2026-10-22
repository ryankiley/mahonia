import { defineEventHandler } from "h3";
import { revokeAllAccessTokens } from "../../utils/accessTokens";
import { endAllSessions, requireAccount } from "../../utils/authSession";

// Sign out everywhere — the answer to "I think someone else is in my account".
//
// Separate from /signout because it does a different thing: that one drops the
// cookie you're holding, this one invalidates every session the account has on
// every device. Requires a live session, so it's an action only the account holder
// can take, and it takes the caller's own session with it (see endAllSessions).
//
// Assistant tokens go too: a token is the one credential an intruder can mint that
// outlives every session, so leaving them would leave the door this is meant to shut.
//
// POST, like signout, so a prefetched link or a cross-site <img> can't trigger it.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account");
  await revokeAllAccessTokens(db, user.id);
  const ended = await endAllSessions(event, user.id);
  return { ok: true as const, ended };
});
