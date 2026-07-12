import { createError, defineEventHandler, setHeader } from "h3";
import { getByEditToken } from "../../utils/listRepo";
import { requireEditToken } from "../../utils/auth";
import { rateLimit } from "../../utils/rateLimit";

export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "poll"); // gate the unauthenticated DB lookup + catalog hydrate
  const token = requireEditToken(event);
  const snapshot = await getByEditToken(token);
  if (!snapshot) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { snapshot };
});
