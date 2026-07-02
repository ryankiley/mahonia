import { createError, defineEventHandler, setHeader } from "h3";
import { requireEditToken } from "../../utils/auth";
import { getPublishState } from "../../utils/discoveryRepo";
import { rateLimit } from "../../utils/rateLimit";

// Current publish state, for the editor's publish dialog to prefill. Capability-
// gated (edit token in the Authorization header); never exposes id/token.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "publishget");
  const token = requireEditToken(event);
  const state = await getPublishState(token);
  if (!state) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { state };
});
