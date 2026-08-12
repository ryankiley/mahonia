import { defineEventHandler } from "h3";
import { getByEditHash } from "../../utils/listRepo";
import { requireEditHash } from "../../utils/editAuth";
import { rateLimit } from "../../utils/rateLimit";
import { notFound, setNoIndex } from "../../utils/http";

export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "poll"); // gate the unauthenticated DB lookup + catalog hydrate
  const hash = await requireEditHash(event);
  const snapshot = await getByEditHash(hash);
  if (!snapshot) throw notFound();
  return { snapshot };
});
