// The shared KV store (Nitro's useStorage("kv"), as server/utils/rateLimit.ts's useKv
// hands it out) for suites that run code reaching for it. Each suite keeps its own mock
// boundary, a useKv mock or a useStorage stub, and takes the store from here, so a
// change to the store's surface is one edit rather than one per suite.
//
// Loaded inside a hoisted mock, a suite imports it there:
//   const kv = await vi.hoisted(async () => (await import("./helpers/kv")).memoryKv());

import type { KvStorage } from "../../server/utils/rateLimit";

export type MemoryKv = KvStorage & {
  /** What is stored, by key. A test may read it, or write to it to age an entry. */
  store: Map<string, unknown>;
  /** The TTL each write asked for, by key, so a test can see a window is bounded. */
  ttls: Map<string, number | undefined>;
  /** Forget everything, between tests. */
  clear: () => void;
};

/** A store that remembers, in memory. It records each write's TTL and expires nothing:
 *  a case that needs an entry gone, or old, changes `store` by hand. */
export function memoryKv(): MemoryKv {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number | undefined>();
  return {
    store,
    ttls,
    getItem: async <T,>(key: string) => (store.get(key) as T | undefined) ?? null,
    setItem: async <T,>(key: string, value: T, opts?: { ttl?: number }) => {
      store.set(key, value);
      ttls.set(key, opts?.ttl);
    },
    removeItem: async (key: string) => {
      store.delete(key);
      ttls.delete(key);
    },
    clear: () => {
      store.clear();
      ttls.clear();
    },
  };
}

/** A store that keeps nothing: every read misses. For a suite the store is not the
 *  subject of, so no answer depends on what an earlier call left behind. */
export function forgetfulKv(): KvStorage {
  return { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
}
