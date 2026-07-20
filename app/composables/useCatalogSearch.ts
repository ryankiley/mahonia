// Debounced, abortable catalog autocomplete client. Consumes /api/catalog/search
// (the catalog session's endpoint): fuzzy, ranked by the shared relevance-tier
// cascade (tier→verified→usage→similarity→id; see shared/catalogSearch.ts).

import type { CatalogSearchResult } from "~~/shared/catalogSearch";
import type { Classification } from "~~/shared/types";
import type { useCatalogCache } from "./useCatalogCache";

// Exactly what /api/catalog/search returns — the shared type IS the contract, so a
// field added there can't be missed here (this was a hand-kept copy of it).
export type CatalogResult = CatalogSearchResult;

/** What ItemInput hands back when a name is committed — a catalog pick (carrying its
 *  structured fields + link), a water suggestion, or free text with an optional trailing
 *  weight. One declaration, so the emit and the row's handler can't drift: a field the
 *  input starts sending but the handler's type omits would otherwise be dropped silently. */
export interface NameCommit {
  name: string;
  brand?: string;
  variant?: string;
  commonName?: string;
  weight?: string;
  weightMg?: number;
  catalogItemId?: number;
  classification?: Classification;
}

export function useCatalogSearch() {
  const results = ref<CatalogResult[]>([]);
  // When the offline flag is on, accumulate an on-device catalog cache from the
  // results the user sees (no bulk endpoint — zero new scraping surface) and fall
  // back to it if the live search can't reach the network. The cache module (and
  // the shared ranking + IDB code behind it) loads DYNAMICALLY so flag-off users
  // never download it; until it resolves, the null cache is simply live-search-only
  // — exactly the flag-off behavior.
  let cache: ReturnType<typeof useCatalogCache> | null = null;
  if (useOfflineEnabled()) {
    import("./useCatalogCache")
      .then((m) => {
        cache = m.useCatalogCache();
        void cache.prime();
      })
      // chunk fetch failed (e.g. offline before the SW cached it) — stay
      // live-search-only rather than surfacing an unhandled rejection
      .catch(() => {});
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let lastQ = "";

  function clear() {
    clearTimeout(timer);
    controller?.abort();
    results.value = [];
    lastQ = "";
  }

  function search(raw: string) {
    const q = raw.trim();
    clearTimeout(timer);
    if (q.length < 2) {
      // full teardown, not just an empty results list: an in-flight request (and
      // its lastQ) would otherwise land later and reopen the menu with results
      // for a query the user already deleted. Resetting lastQ also suppresses the
      // aborted fetch's offline-cache fallback (its guard sees lastQ !== q).
      clear();
      return;
    }
    timer = setTimeout(async () => {
      lastQ = q;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await $fetch<{ results: CatalogResult[] }>("/api/catalog/search", {
          query: { q },
          signal: controller.signal,
        });
        if (lastQ === q) results.value = res.results || [];
        // remember every successful result set (even a superseded one — it's still
        // real catalog data) so offline search has it later
        if (cache && res.results?.length) cache.remember(res.results);
      } catch {
        // A newer keystroke aborted this request → lastQ !== q, leave results be.
        // A genuine failure (offline / network) with the flag on → serve the cached
        // catalog. Flag off → no cache, keep prior results (unchanged behavior).
        if (cache && lastQ === q) results.value = cache.searchLocal(q);
      }
    }, 140);
  }

  return { results, search, clear };
}
