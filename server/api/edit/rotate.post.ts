import { createError, defineEventHandler, setHeader } from "h3";
import { rotateEditToken } from "../../utils/listRepo";
import { requireEditToken } from "../../utils/auth";
import { rateLimit } from "../../utils/rateLimit";

// Revoke + reissue the edit token (e.g. after a leak). The old token 404s after.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "rotate");
  const token = requireEditToken(event);
  const next = await rotateEditToken(token);
  if (!next) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { editToken: next };
});
