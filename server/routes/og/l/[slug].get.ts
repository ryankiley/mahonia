import { defineEventHandler, getRouterParam } from "h3";
import { getPublicCardBySlug } from "../../../utils/discoveryRepo";
import { sendOgCard } from "../../../utils/ogCard";
import { notFound } from "../../../utils/http";
import { rateLimit } from "../../../utils/rateLimit";

// The social-card image for a PUBLIC list — /l/[slug]'s og:image. Resolves only
// while the list is public, exactly like the page (a delisted slug 404s here
// too, so the card dies with the listing). No bumpView: fetching the picture of
// a page isn't a second read of it. No noindex either — the page is indexable,
// and its card follows the page's policy, mirroring /api/l. Render + headers +
// fallback are sendOgCard's — only the lookup is this route's own.
export default defineEventHandler(async (event) => {
  await rateLimit(event, "public-read");
  const list = await getPublicCardBySlug(getRouterParam(event, "slug") || "");
  if (!list) throw notFound();
  return sendOgCard(event, list);
});
