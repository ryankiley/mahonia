import { defineEventHandler, setHeader } from "h3";
import { endSession } from "../../utils/authSession";
import { rateLimit } from "../../utils/rateLimit";

// Sign out. POST (not GET) so a prefetched link or an <img> on another site can't
// log you out, and so SameSite=Lax covers it. Always succeeds — signing out when
// you're already signed out is not an error. Rate-limited like its siblings: each
// call is a DELETE against sessions, and this was the one auth write without a
// throttle.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "auth-me");
  await endSession(event);
  return { ok: true };
});
