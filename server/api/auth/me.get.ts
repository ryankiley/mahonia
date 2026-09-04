import { defineEventHandler } from "h3";
import { resolveSession } from "../../utils/authSession";
import { rateLimit } from "../../utils/rateLimit";
import { setNoIndex, setPrivate } from "../../utils/http";

// Who am I? `{ user: null }` when signed out — an ordinary answer, not a 401, so
// the client can render the signed-out state without treating it as an error.
//
// Never cached: it varies per cookie, and an edge or browser cache holding one
// user's answer is the classic way to serve someone else's identity.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "auth-me");
  const user = await resolveSession(event);
  if (!user) return { user: null };
  // the display name rides along so the account page and anything that renders a
  // byline read one source rather than each fetching their own — and it comes off
  // the session's own join, so this is no second query
  return { user: { email: user.email, displayName: user.displayName } };
});
