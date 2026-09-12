// @vitest-environment nuxt
//
// The debounce lives in an app composable, so exercise it in Nuxt rather than
// copying its ref/timer shape into a plain helper test. The race is specifically
// between a response already on the wire and the next query still waiting out its
// debounce window.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDebouncedSearch } from "~/composables/useDebouncedSearch";

type Pending = {
  query: string;
  signal: AbortSignal;
  resolve: (results: string[]) => void;
};

describe("useDebouncedSearch", () => {
  afterEach(() => vi.useRealTimers());

  it("never lets a superseded response replace the newer query during its debounce", async () => {
    vi.useFakeTimers();
    const pending: Pending[] = [];
    const seen: string[][] = [];
    const { results, search } = useDebouncedSearch<string>(
      (query, signal) =>
        new Promise<string[]>((resolve) => {
          pending.push({ query, signal, resolve });
        }),
      { onResults: (got) => seen.push(got) },
    );

    search("tent");
    await vi.advanceTimersByTimeAsync(140);
    expect(pending.map((p) => p.query)).toEqual(["tent"]);

    // The old request is already in flight. Typing the replacement must invalidate
    // it immediately, not only once the next 140 ms timer gets a chance to run.
    search("pack");
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.resolve(["tent result"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(results.value).toEqual([]);

    await vi.advanceTimersByTimeAsync(140);
    expect(pending.map((p) => p.query)).toEqual(["tent", "pack"]);
    pending[1]!.resolve(["pack result"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(results.value).toEqual(["pack result"]);
    // The old answer is still handed to the optional cache hook; it just cannot
    // repaint the menu that now belongs to the newer input.
    expect(seen).toEqual([["tent result"], ["pack result"]]);
  });

  it("does not draw a result after its caller's account context changes", async () => {
    vi.useFakeTimers();
    const account = ref(1);
    let resolve!: (results: string[]) => void;
    const { results, search } = useDebouncedSearch<string>(
      () => new Promise<string[]>((done) => { resolve = done; }),
      { context: () => account.value },
    );

    search("tent");
    await vi.advanceTimersByTimeAsync(140);
    account.value = 2; // A → B while A's search is still in flight
    resolve(["A's tent"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(results.value).toEqual([]);
  });
});
