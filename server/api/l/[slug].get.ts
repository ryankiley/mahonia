import { defineEventHandler, getRouterParam } from "h3";
import { getPublicBySlug } from "../../utils/discoveryRepo";
import { rateLimit } from "../../utils/rateLimit";
import { notFound, setReadEdgeCache } from "../../utils/http";

// Public, indexable read view by slug. Resolves ONLY if the list is public;
// a private/missing slug is a 404 (never 403 — no existence oracle). Unlike
// /s/[code] (noindex), this address IS meant for search engines. Returns only
// public fields (no id/token).
export default defineEventHandler(async (event) => {
  await rateLimit(event, "public-read"); // bounds cache-busted read floods
  const slug = getRouterParam(event, "slug") || "";
  const list = await getPublicBySlug(slug);
  if (!list) throw notFound();

  // edge-cached like every read surface — see setReadEdgeCache for the window
  setReadEdgeCache(event);
  return { list };
});
