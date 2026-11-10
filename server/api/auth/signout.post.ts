import { defineEventHandler } from "h3";
import { endSession } from "../../utils/authSession";
import { rateLimit } from "../../utils/rateLimit";
import { setNoIndex } from "../../utils/http";
import { refuseCrossSite } from "../../utils/origin";

// Sign out. POST (not GET) so a prefetched link or an <img> on another site can't
// log you out, and so SameSite=Lax covers it. Always succeeds — signing out when
// you're already signed out is not an error. Rate-limited like its siblings: each
// call is a DELETE against sessions, and this was the one auth write without a
// throttle.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  // it clears the cookies whether or not they came along, so a form elsewhere
  // could sign a visitor out, and a signed-out visitor is easier to hand a link
  refuseCrossSite(event);
  await rateLimit(event, "auth-me");
  await endSession(event);
  return { ok: true };
});
