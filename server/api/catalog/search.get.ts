import { defineEventHandler, getQuery, setHeader } from "h3";
import { searchCatalog } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { rateLimit } from "../../utils/rateLimit";

// Maps-grade autocomplete for the gear catalog. `?q=` returns up to 8 fuzzy
// matches ordered `verified DESC, usage_count DESC, similarity DESC`. Fuzzy via
// pg_trgm on Neon, JS trigram ranking on PGlite (see server/utils/catalog.ts).
//
// Public read-only endpoint. The client debounces; we add a short edge cache so
// repeated keystrokes for the same prefix collapse to one DB hit. noindex — this
// is an API surface, not a page.
export default defineEventHandler(async (event) => {
  // Per-IP throttle on the read path — the catalog is the product's moat, so the
  // one real exposure (this endpoint) shouldn't be bulk-scrapeable. Generous
  // enough that real debounced autocomplete never trips it (and identical
  // keystroke prefixes are absorbed by the edge cache below, never reaching here);
  // distinct-query enumeration by a scraper gets capped per IP, forcing rotation.
  // Runs BEFORE the cache headers so a 429 is never cached at the edge. Tunable.
  await rateLimit(event, "catalog-search", 240, 60_000);

  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "public, max-age=2, s-maxage=10");

  const raw = getQuery(event).q;
  const q = (Array.isArray(raw) ? raw[0] : raw ?? "").toString().slice(0, 100);

  const db = await useCatalogDb();
  const results = await searchCatalog(db, q, 8);

  return { results };
});
