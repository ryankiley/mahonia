import { createError, defineEventHandler, setHeader } from "h3";
import { getByEditHash } from "../../utils/listRepo";
import { requireEditHash } from "../../utils/editAuth";
import { rateLimit } from "../../utils/rateLimit";

export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "poll"); // gate the unauthenticated DB lookup + catalog hydrate
  const hash = await requireEditHash(event);
  const snapshot = await getByEditHash(hash);
  if (!snapshot) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { snapshot };
});
