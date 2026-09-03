import type { Ref } from "vue";

// The debounced, abortable autocomplete scaffold, once. The catalog search and the
// vault search had the same timer / AbortController / lastQ / clear() shape written
// out twice — on purpose, so the item input could drive both from one keystroke
// with no special-casing; but two copies of a scaffold drift, and what the two
// actually differ in is small: the fetch itself, a gate (the vault has nothing to
// search without a vault), and what to do with a result set on the side (the
// catalog banks it for offline) or in place of a failed one (the catalog falls
// back to that bank).
//
// 140ms is the one debounce both halves of the menu share, so they settle
// together instead of the list reshuffling twice per keystroke.
const DEBOUNCE_MS = 140;

export function useDebouncedSearch<T>(
  /** the round trip — `signal` aborts it when a newer keystroke supersedes it */
  fetch: (q: string, signal: AbortSignal) => Promise<T[]>,
  opts: {
    /** false → treat as nothing to search (full teardown, no request) */
    ready?: () => boolean;
    /** every successful result set, even one a newer keystroke has superseded */
    onResults?: (results: T[]) => void;
    /** what to show when the request FAILS (not: was aborted) — undefined keeps
     *  the prior results, rather than blanking the menu mid-type */
    fallback?: (q: string) => T[] | undefined;
  } = {},
) {
  const results = ref<T[]>([]) as Ref<T[]>;
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
    if (q.length < 2 || opts.ready?.() === false) {
      // full teardown, not just an empty results list: an in-flight request (and
      // its lastQ) would otherwise land later and reopen the menu with results
      // for a query the user already deleted. Resetting lastQ also suppresses the
      // aborted fetch's fallback (its guard sees lastQ !== q).
      clear();
      return;
    }
    timer = setTimeout(async () => {
      lastQ = q;
      controller?.abort();
      controller = new AbortController();
      try {
        const got = await fetch(q, controller.signal);
        if (lastQ === q) results.value = got;
        opts.onResults?.(got);
      } catch {
        // A newer keystroke aborted this request → lastQ !== q, leave results be.
        // A genuine failure (offline / network) → the caller's fallback, if it has
        // one; otherwise keep the prior results.
        if (lastQ === q) {
          const fb = opts.fallback?.(q);
          if (fb) results.value = fb;
        }
      }
    }, DEBOUNCE_MS);
  }

  return { results, search, clear };
}
