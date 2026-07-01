import type { LocalListRecord } from "~~/shared/localList";
import { openIdb } from "~~/shared/idb";

// Thin promise wrapper over IndexedDB — the on-device backing for the editor's op
// queue (see shared/localList.ts). One object store, key→LocalListRecord. Every
// call is best-effort: if IndexedDB is unavailable (private mode, quota, SSR) the
// store quietly no-ops and the editor falls back to today's in-memory behaviour —
// persistence must never block or break an edit.

const DB_NAME = "mahonia";
const STORE = "lists";
const DB_VERSION = 1;

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openIdb(DB_NAME, DB_VERSION, STORE).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function useLocalListStore() {
  const enabled = import.meta.client && typeof indexedDB !== "undefined";

  async function get(key: string): Promise<LocalListRecord | undefined> {
    if (!enabled) return undefined;
    try {
      return await tx<LocalListRecord | undefined>("readonly", (s) => s.get(key));
    } catch {
      return undefined;
    }
  }

  async function set(key: string, record: LocalListRecord): Promise<void> {
    if (!enabled) return;
    try {
      // The snapshot is a Vue reactive proxy, which IndexedDB's structured clone
      // rejects (DataCloneError). A JSON round-trip yields the plain, serialisable
      // data we actually want to persist — the record is JSON-safe by construction.
      const plain: LocalListRecord = JSON.parse(JSON.stringify(record));
      await tx("readwrite", (s) => s.put(plain, key));
    } catch {
      /* best-effort */
    }
  }

  async function del(key: string): Promise<void> {
    if (!enabled) return;
    try {
      await tx("readwrite", (s) => s.delete(key));
    } catch {
      /* best-effort */
    }
  }

  return { get, set, del };
}
