// Debounced, abortable catalog autocomplete client. Consumes /api/catalog/search
// (the catalog session's endpoint): fuzzy, ranked verified→usage→similarity.

export interface CatalogResult {
  id: number;
  brand: string | null;
  name: string;
  variant: string | null;
  weightMg: number;
  weightSource: string;
  verified: boolean;
}

export function useCatalogSearch() {
  const results = ref<CatalogResult[]>([]);
  // When the offline flag is on, accumulate an on-device catalog cache from the
  // results the user sees (no bulk endpoint — zero new scraping surface) and fall
  // back to it if the live search can't reach the network. Flag off → inert; this
  // behaves exactly as before (server-only).
  const cache = useOfflineEnabled() ? useCatalogCache() : null;
  if (cache) void cache.prime();
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
      results.value = [];
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
