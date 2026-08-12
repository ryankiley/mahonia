import { defineEventHandler, getRouterParam, sendRedirect, setHeader } from "h3";
import { ogCardModel } from "../../../../shared/ogCard";
import { computeTotals } from "../../../../shared/weights";
import { getByShareCode } from "../../../utils/listRepo";
import { renderOgCard } from "../../../utils/ogCard";
import { ogFonts } from "../../../utils/ogFonts";
import { notFound, setNoIndex } from "../../../utils/http";
import { rateLimit } from "../../../utils/rateLimit";

// The social-card image for a shared list — what /s/[code]'s (and /e/[code]'s)
// og:image points at. Same read capability as the page: the share code resolves
// it, and it shows nothing the page doesn't. Lives under routes/, not api/, with
// the other non-JSON artifacts (sitemap, robots); noindex like its page, so the
// card can't outlive the link in image search.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "public-read");
  const code = getRouterParam(event, "code") || "";
  const snapshot = await getByShareCode(code);
  if (!snapshot) throw notFound();
  try {
    const model = ogCardModel(snapshot.title, computeTotals(snapshot), snapshot.displayUnit);
    const png = await renderOgCard(model, await ogFonts());
    setHeader(event, "Content-Type", "image/png");
    // same edge window as the page + /api/s, so the pair a crawler fetches
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
