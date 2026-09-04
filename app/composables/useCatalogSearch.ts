// Debounced, abortable catalog autocomplete client. Consumes /api/catalog/search
// (the catalog session's endpoint): fuzzy, ranked by the shared relevance-tier
// cascade (tier→verified→usage→similarity→id; see shared/catalogSearch.ts).

import type { CatalogSearchResult } from "~~/shared/catalogSearch";
import type { Classification } from "~~/shared/types";
import type { useCatalogCache } from "./useCatalogCache";
import { useDebouncedSearch } from "./useDebouncedSearch";

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
  // what the item cost, when it came from the vault — the vault is where a price
  // is recorded, so a pick carries it into the list rather than losing it
  priceCents?: number;
  currency?: string;
  // food energy per unit, when the vault remembers it — same journey as the price:
  // recorded once, carried back into every later list
  kcal?: number;
  // Came from the holder's vault rather than the catalog. The fields look the same,
  // but their AUTHORITY differs: a vault row's weight and name are the holder's own,
  // so the handler marks them overridden instead of letting the catalog's
  // live-resolve keep them "fresh". See ItemRow's onNameCommit.
  fromVault?: boolean;
}

export function useCatalogSearch() {
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
  return useDebouncedSearch<CatalogResult>({
    fetch: (q, signal) =>
      $fetch<{ results: CatalogResult[] }>("/api/catalog/search", { query: { q }, signal }),
    // remember every successful result set (even a superseded one — it's still
    // real catalog data) so offline search has it later
    onResults: (found) => cache?.remember(found),
    // a genuine failure (offline / network) with the flag on → serve the cached
    // catalog; flag off → no cache, keep the prior results
    onFail: (q) => cache?.searchLocal(q),
  });
}
