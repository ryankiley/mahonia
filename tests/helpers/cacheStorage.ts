// The browser's Cache Storage (`caches`), stubbed for the suites that keep something in
// it. Neither Node nor happy-dom has one. Map-backed, and the Maps are handed back so a
// test can read what was really kept. `put` over an existing entry keeps its place, the
// most a browser promises, so code that needs an entry to move has to move it.

import { vi } from "vitest";

type Key = string | { url: string };

/** Stub the `caches` global and return the entries behind it, by cache name then URL. */
export function stubCacheStorage(): Map<string, Map<string, Response>> {
  const stores = new Map<string, Map<string, Response>>();
  const urlOf = (key: Key) => new URL(typeof key === "string" ? key : key.url, "https://mahonia.app").pathname;
  vi.stubGlobal("caches", {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        put: async (key: Key, res: Response) => void store.set(urlOf(key), res),
        match: async (key: Key) => store.get(urlOf(key))?.clone(),
        delete: async (key: Key) => store.delete(urlOf(key)),
        keys: async () => [...store.keys()].map((url) => ({ url })),
      };
    },
  });
  return stores;
}
