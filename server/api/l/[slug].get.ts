import { createError, defineEventHandler, getRouterParam, setHeader } from "h3";
import { bumpView, getPublicBySlug } from "../../utils/discoveryRepo";
import { rateLimit } from "../../utils/rateLimit";

// Public, indexable read view by slug. Resolves ONLY if the list is public;
// a private/missing slug is a 404 (never 403 — no existence oracle). Unlike
// /s/[code] (noindex), this address IS meant for search engines. Best-effort
// view bump powers the "most-viewed" feed sort (undercounts under CDN cache —
// acceptable + burst-resistant). Returns only public fields (no id/token).
export default defineEventHandler(async (event) => {
  await rateLimit(event, "public-read"); // bounds cache-busted read + view_count-write floods
  const slug = getRouterParam(event, "slug") || "";
  const list = await getPublicBySlug(slug);
  if (!list) throw createError({ statusCode: 404, statusMessage: "Not found" });

  await bumpView(slug);

  // edge-cache the read for a short window (collapses refresh/crawler bursts)
  setHeader(
    event,
    "Cache-Control",
    "public, max-age=0, s-maxage=30, stale-while-revalidate=120",
  );
  return { list };
});
