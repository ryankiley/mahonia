import { defineEventHandler } from "h3";
import { requireEditHash } from "../../utils/editAuth";
import { publishListByEditHash } from "../../utils/discoveryRepo";
import { notFound, readJsonBodyCapped, setNoIndex } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

// Make a list public/private + set its publish facets (trip type, season). Write
// capability resolved by editAuth (edit token in the Authorization header, or a
// session naming a claimed list) — never the path, so the public routes can never
// expose or derive it.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "publish");
  const hash = await requireEditHash(event);
  const body = await readJsonBodyCapped<{
    isPublic?: boolean;
    tripType?: string | null;
    season?: string | null;
  }>(event, 8_000);

  const state = await publishListByEditHash(hash, {
    isPublic: !!body?.isPublic,
    tripType: body?.tripType ?? null,
    season: body?.season ?? null,
  });
  if (!state) throw notFound();
  return { state };
});
