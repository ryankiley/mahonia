// A tiny, per-name-memoized IndexedDB opener shared by the on-device stores
// (app/composables/useLocalListStore + useCatalogCache). Only the open/upgrade
// dance lives here — the part that's identical across both and easy to get subtly
// wrong on a version bump. Each store keeps its OWN transaction + error-policy
// layer (they differ on purpose: the list store rejects and lets callers catch;
// the catalog cache swallows).
//
// Memoized per DB NAME via a Map (NOT a single shared promise) so opening
// "mahonia" and "mahonia-catalog" get independent handles and never cross-wire.
// Rejects on open failure, so each caller's own best-effort catch still applies.
// Only ever called client-side (both callers gate on `indexedDB` existing).

const dbPromises = new Map<string, Promise<IDBDatabase>>();

/** Open (once per `name`) an IndexedDB with a single object store, creating the
 *  store on upgrade. Returns a memoized promise; rejects if the open fails. */
export function openIdb(name: string, version: number, store: string): Promise<IDBDatabase> {
  let p = dbPromises.get(name);
  if (!p) {
    p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromises.set(name, p);
  }
  return p;
}
