import { defineEventHandler } from "h3";
import { requireEditHash } from "../../utils/editAuth";
import { getPublishStateByEditHash } from "../../utils/discoveryRepo";
import { rateLimit } from "../../utils/rateLimit";
import { notFound, setNoIndex } from "../../utils/http";

// Current publish state, for the editor's publish dialog to prefill. Capability-
// gated (edit token, or session + claimed code — see editAuth); never exposes
// id/token.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "publishget");
  const hash = await requireEditHash(event);
  const state = await getPublishStateByEditHash(hash);
  if (!state) throw notFound();
  return { state };
});
