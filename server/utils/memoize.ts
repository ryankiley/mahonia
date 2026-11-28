// Run an idempotent async step (the schema ensure, a font load) at most once per
// process — but RESET the memo if it rejects, so a transient cold-start failure (a
// Neon blip on the very first request) retries instead of caching a rejected
// promise and wedging every later request. The arguments are taken per call and
// captured from the FIRST call; later arguments are ignored, matching the
// memoized-once semantics. Single-sourced here so useDb's schema ensure and the card
// renderer's font load can't drift on this subtle idiom.
export function memoized<A extends unknown[], T>(run: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let value: Promise<T> | undefined;
  return (...args: A): Promise<T> => {
    if (!value) {
      value = run(...args).catch((e) => {
        value = undefined;
        throw e;
      });
    }
    return value;
  };
}
