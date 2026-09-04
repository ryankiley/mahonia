import type { Ref } from "vue";

/**
 * The debounced, abortable autocomplete skeleton the catalog and vault searches
 * share: one timer, one in-flight request, and a `lastQ` that decides whether a
 * late answer still belongs to what's in the box.
 *
 * `fetch` does the round trip. `gate` says whether there is anything to search at
 * all (the vault, with no vault); a query under two characters or a closed gate is
 * a full teardown, not just an empty results list — an in-flight request (and its
 * lastQ) would otherwise land later and reopen the menu with results for a query
 * the user already deleted. `onResults` sees every successful result set, even a
 * superseded one; `onFail` may answer a genuine failure (offline, network) with
 * fallback results — a request aborted by a newer keystroke never reaches it.
 *
 * 140 ms, so the two halves of the item input's menu settle together instead of
 * the list reshuffling twice per keystroke.
 */
export function useDebouncedSearch<T>(opts: {
  fetch: (q: string, signal: AbortSignal) => Promise<{ results?: T[] } | null | undefined>;
  gate?: () => boolean;
  onResults?: (results: T[]) => void;
  onFail?: (q: string) => T[] | undefined;
}) {
  const results = ref([]) as Ref<T[]>;
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
    if (q.length < 2 || (opts.gate && !opts.gate())) {
      clear();
      return;
    }
    timer = setTimeout(async () => {
      lastQ = q;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await opts.fetch(q, controller.signal);
        const found = res?.results || [];
        if (lastQ === q) results.value = found;
        if (found.length) opts.onResults?.(found);
      } catch {
        // aborted by a newer keystroke → lastQ !== q, leave the results be rather
        // than blanking the menu mid-type; a real failure may fall back
        if (lastQ === q) {
          const fallback = opts.onFail?.(q);
          if (fallback) results.value = fallback;
        }
      }
    }, 140);
  }

  return { results, search, clear };
}
