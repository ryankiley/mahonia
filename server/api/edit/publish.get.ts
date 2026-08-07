import { createError, defineEventHandler, setHeader } from "h3";
import { requireEditHash } from "../../utils/editAuth";
import { getPublishStateByEditHash } from "../../utils/discoveryRepo";
import { rateLimit } from "../../utils/rateLimit";

// Current publish state, for the editor's publish dialog to prefill. Capability-
// gated (edit token, or session + claimed code — see editAuth); never exposes
// id/token.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "publishget");
  const hash = await requireEditHash(event);
  const state = await getPublishStateByEditHash(hash);
  if (!state) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { state };
});
