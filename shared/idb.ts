// A tiny, per-name-memoized IndexedDB opener shared by the on-device stores
// (app/composables/useLocalListStore + useCatalogCache), and the one-request
// transaction over it. The open/upgrade dance is the part that's identical across
// both and easy to get subtly wrong on a version bump; the request wrapper was then
// written three times on top of it. Error POLICY still differs on purpose — the list
// store rejects and lets callers catch, the catalog cache swallows — and that is one
// `.catch` at the cache's call sites rather than a second wrapper.
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

/** One request in its own transaction on the store: resolves with the result, rejects
 *  with the request's error (or the open's). */
export function idbRequest<T>(
  name: string,
  version: number,
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openIdb(name, version, store).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}
