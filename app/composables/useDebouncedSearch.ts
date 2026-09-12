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
    /** A caller-owned lifetime such as the signed-in account. A response may draw
     * only if it still belongs to the same context that started the search. */
    context?: () => unknown;
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
  // A query can change while its replacement is still sitting in the debounce.
  // `lastQ` used to change only when that replacement's timer fired, which left a
  // 140 ms window where the old request could resolve and overwrite the menu for
  // the text now in the field. A monotonically increasing intent changes at input
  // time, before the next request exists, so an old response can never become the
  // current query again (including A → B → A).
  let intent = 0;

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    results.value = [];
    intent++;
  }

  function search(raw: string) {
    const q = raw.trim();
    clearTimeout(timer);
    timer = undefined;
    // Abort as soon as the text changes, rather than 140 ms later when its
    // replacement starts. Apart from saving a needless request, this makes the
    // old request's cancellation match the visible query immediately.
    controller?.abort();
    controller = undefined;
    const mine = ++intent;
    const context = opts.context?.();
    if (q.length < 2 || opts.ready?.() === false) {
      // Full teardown, not just an empty results list: an in-flight request would
      // otherwise land later and reopen the menu with results for a query the user
      // already deleted. `mine` already invalidated it above.
      results.value = [];
      return;
    }
    timer = setTimeout(async () => {
      // A later keystroke cancelled this timer just before it got CPU time.
      if (mine !== intent || context !== opts.context?.()) return;
      const request = new AbortController();
      controller = request;
      try {
        const got = await fetch(q, request.signal);
        if (mine === intent && controller === request && context === opts.context?.()) results.value = got;
        // A superseded answer is still real catalog data, so callers that warm a
        // local cache intentionally receive it even though it no longer draws.
        opts.onResults?.(got);
      } catch {
        // A newer keystroke aborted this request → its intent no longer owns the
        // menu. A genuine failure (offline / network) asks the caller for a
        // fallback; otherwise keep the prior results.
        if (mine === intent && controller === request && context === opts.context?.()) {
          const fb = opts.fallback?.(q);
          if (fb) results.value = fb;
        }
      }
    }, DEBOUNCE_MS);
  }

  return { results, search, clear };
}
