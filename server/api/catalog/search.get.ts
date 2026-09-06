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
// Public read-only endpoint. The client debounces; the edge cache below turns a
// repeated query into a hit that never reaches this function. Measured from the
// west coast against production: a miss is ~180–320 ms (the hop to the function's
// region, the limiter's store, the query), a hit ~57 ms. Two minutes of freshness
// is short enough that a correction applied for everyone shows up in search
// within the same sitting, and the stale-while-revalidate window keeps a popular
// query answering from the edge while it refreshes. noindex — this is an API
// surface, not a page.
export default defineEventHandler(async (event) => {
  // Per-IP throttle on the read path — the catalog is the product's moat, so the
  // one real exposure (this endpoint) shouldn't be bulk-scrapeable. Generous
  // enough that real debounced autocomplete never trips it (and identical
  // keystroke prefixes are absorbed by the edge cache below, never reaching here);
  // distinct-query enumeration by a scraper gets capped per IP, forcing rotation.
  // Runs BEFORE the cache headers so a 429 is never cached at the edge. Tunable.
  await rateLimit(event, "catalog-search");

  setNoIndex(event);
  setHeader(event, "Cache-Control", "public, max-age=2, s-maxage=120, stale-while-revalidate=600");

  const raw = getQuery(event).q;
  const q = (Array.isArray(raw) ? raw[0] : raw ?? "").toString().slice(0, 100);

  const db = await useCatalogDb();
  const results = await searchCatalog(db, q, SEARCH_LIMIT);

  return { results };
});
