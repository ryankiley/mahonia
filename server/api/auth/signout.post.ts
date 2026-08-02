import { defineEventHandler, setHeader } from "h3";
import { endSession } from "../../utils/authSession";

// Sign out. POST (not GET) so a prefetched link or an <img> on another site can't
// log you out, and so SameSite=Lax covers it. Always succeeds — signing out when
// you're already signed out is not an error.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await endSession(event);
  return { ok: true };
});
