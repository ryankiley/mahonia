// Run an idempotent async step (a schema DDL-ensure, a font load) at most once per
// process — but RESET the memo if it rejects, so a transient cold-start failure (a
// Neon blip on the very first request) retries instead of caching a rejected
// promise and wedging every later request. The arguments are taken per call and
// captured from the FIRST call; later arguments are ignored, matching the
// memoized-once semantics. The returned function carries a `.reset()` that clears
// the memo (used by tests that spin up a fresh database). Single-sourced here so
// the schema-ensure helpers (lists / snapshots / catalog / candidates / vault /
// account) and the card renderer's font load can't drift on this subtle idiom.
export function memoized<A extends unknown[], T>(
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
