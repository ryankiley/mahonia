import { createError, defineEventHandler, setHeader } from "h3";
import { softDeleteByEditToken } from "../../utils/listRepo";
import { requireEditToken } from "../../utils/auth";
import { rateLimit } from "../../utils/rateLimit";

// Owner-initiated delete of the whole list. Edit-token-gated like rotate: the
// capability travels in the Authorization header, and an unresolvable token 404s
// (no existence oracle). Soft-delete — the list vanishes from every lookup now,
// the nightly purge reclaims it after the grace window.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "delete");
  const token = requireEditToken(event);
  const ok = await softDeleteByEditToken(token);
  if (!ok) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { ok: true };
});
