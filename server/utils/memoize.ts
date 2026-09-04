// Run an idempotent side effect (a schema DDL-ensure) at most once per process —
// but RESET the memo if it rejects, so a transient cold-start failure (a Neon blip
// on the very first request) retries instead of caching a rejected promise and
// wedging every later request. The handle is taken per call and captured from the
// FIRST call; later handles are ignored, matching the memoized-once semantics. The
// returned function carries a `.reset()` that clears the memo (used by tests that
// spin up a fresh database). Single-sourced here so the seven schema-ensure helpers
// (lists / snapshots / trail favicons / vault / account in db.ts, catalog,
// candidates) can't drift on this subtle idiom.
export function memoizedEnsure<A>(
  run: (arg: A) => Promise<void>,
): ((arg: A) => Promise<void>) & { reset(): void } {
  return memoized(run);
}

/** The same idiom for a once-per-process VALUE (the card renderer's fonts):
 *  computed on first call, shared by concurrent first callers, and — the part
 *  worth single-sourcing — RESET on rejection, so a transient cold-start
 *  failure retries on the next request instead of wedging the instance on a
 *  cached rejected promise. */
export function memoizedOnce<T>(run: () => Promise<T>): (() => Promise<T>) & { reset(): void } {
  return memoized(run);
}

/** The one implementation under both: the promise of the FIRST call is the memo,
 *  a rejection clears it, and `.reset()` clears it by hand. */
function memoized<A extends unknown[], T>(
  run: (...args: A) => Promise<T>,
): ((...args: A) => Promise<T>) & { reset(): void } {
  let value: Promise<T> | undefined;
  const once = (...args: A): Promise<T> => {
    if (!value) {
      value = run(...args).catch((e) => {
        value = undefined;
        throw e;
      });
    }
    return value;
  };
  once.reset = () => {
    value = undefined;
  };
  return once;
}
