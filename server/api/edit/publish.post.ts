import { createError, defineEventHandler, setHeader } from "h3";
import { requireEditToken } from "../../utils/auth";
import { publishList } from "../../utils/discoveryRepo";
import { readJsonBody } from "../../utils/http";
import { assertMaxBody, rateLimit } from "../../utils/rateLimit";

// Make a list public/private + set its feed facets. Write capability: the edit
// token travels in the Authorization header (same as edit/mutate), never the
// path — so the public feed/routes can never expose or derive it.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "publish");
  assertMaxBody(event, 8_000);
  const token = requireEditToken(event);
  const body = await readJsonBody<{
    isPublic?: boolean;
    tripType?: string | null;
    season?: string | null;
  }>(event);

  const state = await publishList(token, {
    isPublic: !!body?.isPublic,
    tripType: body?.tripType ?? null,
    season: body?.season ?? null,
  });
  if (!state) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { state };
});
