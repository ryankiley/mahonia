import {
  mergeCatalogRows,
  searchCatalogLocal,
  type CatalogSearchResult,
  type LocalCatalogRow,
} from "~~/shared/catalogSearch";
import { openIdb } from "~~/shared/idb";

// On-device catalog cache for offline autocomplete, built INCREMENTALLY from the
// results the user actually sees while online — there's no bulk-dump endpoint, so
// this adds zero new scraping surface beyond the already-rate-limited
// /api/catalog/search. Offline, searches run in memory against the accumulated rows
// with the SAME ranking the server uses (shared/catalogSearch). Best-effort
// throughout: any failure just leaves the prior cache in place. (Trade-off: offline
// only finds gear you've looked up before; never-seen gear falls back to typing a
// name + weight by hand, exactly as today.)

interface CatalogCacheRecord {
  items: LocalCatalogRow[];
  updatedAt: number;
}

const DB_NAME = "mahonia-catalog";
const STORE = "snapshot";
const KEY = "catalog";
const DB_VERSION = 1;
const MAX_ITEMS = 2000; // bounded; far above what one person realistically searches

function idbGet(): Promise<CatalogCacheRecord | undefined> {
  return openIdb(DB_NAME, DB_VERSION, STORE)
    .then(
      (db) =>
        new Promise<CatalogCacheRecord | undefined>((res) => {
          const r = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
          r.onsuccess = () => res(r.result);
          r.onerror = () => res(undefined);
        }),
    )
    .catch(() => undefined);
}
function idbSet(record: CatalogCacheRecord): Promise<void> {
  return openIdb(DB_NAME, DB_VERSION, STORE)
    .then(
      (db) =>
        new Promise<void>((res) => {
          const r = db.transaction(STORE, "readwrite").objectStore(STORE).put(record, KEY);
          r.onsuccess = () => res();
          r.onerror = () => res();
        }),
    )
    .catch(() => {});
}

// In-memory index, shared across every autocomplete instance on the page.
let memItems: LocalCatalogRow[] = [];
let primed = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

export function useCatalogCache() {
  const enabled = import.meta.client && typeof indexedDB !== "undefined";

  // Load the accumulated cache from a prior session into memory (once).
  async function prime(): Promise<void> {
    if (!enabled || primed) return;
    primed = true;
    const rec = await idbGet();
    if (rec?.items?.length) memItems = rec.items;
  }

  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void idbSet({ items: memItems, updatedAt: Date.now() });
    }, 1500);
  }

  // Fold a live search's results into the on-device cache (deduped, capped). Cached
  // rows carry no usage_count, so offline ranking falls back to verified → score.
  function remember(results: CatalogSearchResult[]) {
    if (!enabled || !results.length) return;
    const incoming: LocalCatalogRow[] = results.map((r) => ({ ...r, usageCount: 0 }));
    memItems = mergeCatalogRows(memItems, incoming, MAX_ITEMS);
    persistSoon();
  }

  function searchLocal(q: string): CatalogSearchResult[] {
    return searchCatalogLocal(memItems, q);
  }

  return {
    prime,
    remember,
    searchLocal,
    get size() {
      return memItems.length;
    },
  };
}
