import { defineEventHandler, getRouterParam, sendRedirect, setHeader } from "h3";
import { ogCardModel } from "../../../../shared/ogCard";
import { computeTotals } from "../../../../shared/weights";
import { getPublicBySlug } from "../../../utils/discoveryRepo";
import { renderOgCard } from "../../../utils/ogCard";
import { ogFonts } from "../../../utils/ogFonts";
import { notFound } from "../../../utils/http";
import { rateLimit } from "../../../utils/rateLimit";

// The social-card image for a PUBLIC list — /l/[slug]'s og:image. Resolves only
// while the list is public, exactly like the page (a delisted slug 404s here
// too, so the card dies with the listing). No bumpView: fetching the picture of
// a page isn't a second read of it. No noindex either — the page is indexable,
// and its card follows the page's policy, mirroring /api/l.
export default defineEventHandler(async (event) => {
  await rateLimit(event, "public-read");
  const slug = getRouterParam(event, "slug") || "";
  const list = await getPublicBySlug(slug);
  if (!list) throw notFound();
  try {
    const model = ogCardModel(list.title, computeTotals(list), list.displayUnit);
    const png = await renderOgCard(model, await ogFonts());
    setHeader(event, "Content-Type", "image/png");
    // same edge window as the page + /api/l, so the pair a crawler fetches
    // (HTML, then image) goes stale together
    setHeader(
      event,
      "Cache-Control",
      "public, max-age=0, s-maxage=30, stale-while-revalidate=120",
    );
    return png;
  } catch {
    // the card is best-effort chrome — a render failure falls back to the static
    // site card rather than a broken unfurl. no-store: never cache the outage.
    setHeader(event, "Cache-Control", "no-store");
    return sendRedirect(event, "/og.jpg", 302);
  }
});
