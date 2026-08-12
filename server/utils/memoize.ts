// Run an idempotent side effect (a schema DDL-ensure) at most once per process —
// but RESET the memo if it rejects, so a transient cold-start failure (a Neon blip
// on the very first request) retries instead of caching a rejected promise and
// wedging every later request. The handle is taken per call and captured from the
// FIRST call; later handles are ignored, matching the memoized-once semantics. The
// returned function carries a `.reset()` that clears the memo (used by tests that
// spin up a fresh database). Single-sourced here so the four schema-ensure helpers
// (lists / snapshots / catalog / candidates) can't drift on this subtle idiom.
export function memoizedEnsure<A>(
  run: (arg: A) => Promise<void>,
): ((arg: A) => Promise<void>) & { reset(): void } {
  let ensured: Promise<void> | undefined;
  const ensure = (arg: A): Promise<void> => {
    if (!ensured) {
      ensured = run(arg).catch((e) => {
        ensured = undefined;
        throw e;
      });
    }
    return ensured;
  };
  ensure.reset = () => {
    ensured = undefined;
  };
  return ensure;
}

/** The same idiom for a once-per-process VALUE (the card renderer's fonts):
 *  computed on first call, shared by concurrent first callers, and — the part
 *  worth single-sourcing — RESET on rejection, so a transient cold-start
 *  failure retries on the next request instead of wedging the instance on a
 *  cached rejected promise. */
export function memoizedOnce<T>(run: () => Promise<T>): (() => Promise<T>) & { reset(): void } {
  let value: Promise<T> | undefined;
  const once = (): Promise<T> => {
    if (!value) {
      value = run().catch((e) => {
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
