import { defineEventHandler, getRouterParam } from "h3";
import { getCardByShareCode } from "../../../utils/listRepo";
import { sendOgCard } from "../../../utils/ogCard";
import { notFound, setNoIndex } from "../../../utils/http";
import { rateLimit } from "../../../utils/rateLimit";

// The social-card image for a shared list — what /s/[code]'s (and /e/[code]'s)
// og:image points at. Same read capability as the page: the share code resolves
// it, and it shows nothing the page doesn't. Lives under routes/, not api/, with
// the other non-JSON artifacts (sitemap, robots); noindex like its page, so the
// card can't outlive the link in image search. Render + headers + fallback are
// sendOgCard's — only the lookup and the indexability are this route's own.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "public-read");
  const snapshot = await getCardByShareCode(getRouterParam(event, "code") || "");
  if (!snapshot) throw notFound();
  return sendOgCard(event, snapshot);
});
