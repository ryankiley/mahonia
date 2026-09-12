// @vitest-environment nuxt
//
// This is intentionally a composable-level test: the failure requires an IndexedDB
// read, a live result, and their ordering against the module's shared in-memory
// cache. The pure merge helper is already covered independently.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const idb = vi.hoisted(() => ({ openIdb: vi.fn() }));
vi.mock("~~/shared/idb", () => idb);

type ReadRequest = {
  result?: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
};

const row = (id: number, name: string) => ({
  id,
  brand: null,
  name,
  variant: null,
  weightMg: 100_000,
  weightSource: "manufacturer",
  verified: true,
});

describe("useCatalogCache", () => {
  const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    idb.openIdb.mockReset();
    // The composable only needs the feature check; the mocked opener supplies the
    // database transaction below.
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {} });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    if (originalIndexedDb) Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });

  it("keeps a live result that arrives before the persisted cache finishes priming", async () => {
    const request: ReadRequest = { onsuccess: null, onerror: null };
    idb.openIdb.mockResolvedValue({
      transaction: () => ({
        objectStore: () => ({ get: () => request }),
      }),
    });

    const { useCatalogCache } = await import("~/composables/useCatalogCache");
    const cache = useCatalogCache();
    const priming = cache.prime();
    await Promise.resolve();
    await Promise.resolve();

    cache.remember([row(2, "Trail Pack")]);
    request.result = { items: [{ ...row(1, "Tent"), usageCount: 7 }], updatedAt: 1 };
    request.onsuccess?.();
    await priming;

    expect(cache.searchLocal("tent").map((item) => item.id)).toEqual([1]);
    expect(cache.searchLocal("pack").map((item) => item.id)).toEqual([2]);
  });
});
