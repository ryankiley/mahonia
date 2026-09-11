// The browser's localStorage, stubbed for the suites that read or write through it.
// Node's own localStorage global is inert without --localstorage-file (every method
// throws), and happy-dom's, while real, carries state in from another suite and
// can't be cleared between cases. A Map-backed stub is what the browser actually
// gives the code, and the Map is handed back so a test can check that a write
// really landed. Ten files each held an identical copy before it lived here.

import { vi } from "vitest";

/** Stub the localStorage global and return the Map behind it. */
export function stubLocalStorage(): Map<string, string> {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  });
  return storage;
}
