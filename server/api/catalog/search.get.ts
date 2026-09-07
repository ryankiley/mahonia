import { defineEventHandler, getQuery, setHeader } from "h3";
import { searchCatalog } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { rateLimit } from "../../utils/rateLimit";
import { SEARCH_LIMIT } from "../../../shared/catalogSearch";
import { setNoIndex } from "../../utils/http";

// Maps-grade autocomplete for the gear catalog. `?q=` returns up to SEARCH_LIMIT
// fuzzy matches ordered by the shared relevance-tier cascade (tier → verified →
// usage_count → similarity → id, then a diversity cap for kind-of-gear queries;
// see shared/catalogSearch.ts). Fuzzy recall via
// pg_trgm on Neon, whole-table JS on PGlite (see server/utils/catalog.ts).
//
// Public read-only endpoint. The client debounces; we add a short edge cache so
// repeated keystrokes for the same prefix collapse to one DB hit. noindex — this
// is an API surface, not a page.
//
// SHORT ON PURPOSE, though a longer window would pay: measured from the west coast
// against production, a miss is ~180–320 ms (the hop to the function's region, the
// limiter's store, the query) and an edge hit ~57 ms. What forbids stretching it is
// the on-device catalog cache (app/composables/useCatalogCache.ts), which folds
// every result set in with the server's copy winning by id — it treats whatever
// this endpoint returns as the freshest truth. A correction applied "for
// everyone" changes a row in place under the same id, so an edge entry older than
// that correction would not just show the old weight in the dropdown for the
// window's length, it would write it back over the corrected row on the device.
// Ten seconds keeps that to a keystroke's worth; a real cache lever here needs a
// key that changes with the catalog, not a longer clock.
export default defineEventHandler(async (event) => {
  // Per-IP throttle on the read path — the catalog is the product's moat, so the
  // one real exposure (this endpoint) shouldn't be bulk-scrapeable. Generous
  // enough that real debounced autocomplete never trips it (and identical
  // keystroke prefixes are absorbed by the edge cache below, never reaching here);
  // distinct-query enumeration by a scraper gets capped per IP, forcing rotation.
  // Runs BEFORE the cache headers so a 429 is never cached at the edge. Tunable.
  await rateLimit(event, "catalog-search");

  setNoIndex(event);
  setHeader(event, "Cache-Control", "public, max-age=2, s-maxage=10");

  const raw = getQuery(event).q;
  const q = (Array.isArray(raw) ? raw[0] : raw ?? "").toString().slice(0, 100);

  const db = await useCatalogDb();
  const results = await searchCatalog(db, q, SEARCH_LIMIT);

  return { results };
});
