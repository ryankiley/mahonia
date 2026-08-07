import { createError, defineEventHandler, setHeader } from "h3";
import { softDeleteByEditHash } from "../../utils/listRepo";
import { requireEditHash } from "../../utils/editAuth";
import { rateLimit } from "../../utils/rateLimit";

// Owner-initiated delete of the whole list. Capability-gated like rotate (edit
// token, or session + claimed code — see editAuth), and an unresolvable
// capability 404s (no existence oracle). Soft-delete — the list vanishes from
// every lookup now, the nightly purge reclaims it after the grace window.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "delete");
  const hash = await requireEditHash(event);
  const ok = await softDeleteByEditHash(hash);
  if (!ok) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { ok: true };
});
