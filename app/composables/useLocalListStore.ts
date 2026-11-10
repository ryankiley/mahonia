import { CLAIMED_KEY_PREFIX, copyReadableBy, type LocalListRecord } from "~~/shared/localList";
import { idbRequest } from "~~/shared/idb";
import { sessionAccount } from "../utils/sessionOwner";

// Thin promise wrapper over IndexedDB — the on-device backing for the editor's op
// queue (see shared/localList.ts). One object store, key→LocalListRecord. Every
// call is best-effort: if IndexedDB is unavailable (private mode, quota, SSR) the
// store quietly no-ops and the editor falls back to today's in-memory behaviour —
// persistence must never block or break an edit.

const DB_NAME = "mahonia";
const STORE = "lists";
const DB_VERSION = 1;

const tx = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) =>
  idbRequest(DB_NAME, DB_VERSION, STORE, mode, run);

// A CLAIMED open's copy (a list reached by share code + session) is the account's
// view of that list: the route line and waypoints the share link withholds, and
// whatever was typed and not yet sent. So it is the account's the way My Gear's
// copy is, and it used to be the one per-account thing that outlived a sign-out:
// the next person at this browser opened the same address and was shown it.
//
// So a copy is stamped with the ACCOUNT it was written for and read back only by
// that account's sessions. The account, not the session: a session is new with
// every sign-in, and edits typed offline have to be there when their person comes
// back, whichever session that is. For the same reason leaving an account
// (delClaimed) drops only the copies with nothing unsent in them; one still
// holding edits waits, unreadable to anyone else, for its account to return.
//
// A copy from before the stamp existed has nothing to compare and is still read,
// so nothing typed offline is lost to the upgrade.
const isClaimedKey = (key: string) => key.startsWith(CLAIMED_KEY_PREFIX);

export function useLocalListStore() {
  const enabled = import.meta.client && typeof indexedDB !== "undefined";

  async function get(key: string): Promise<LocalListRecord | undefined> {
    if (!enabled) return undefined;
    try {
      const record = await tx<LocalListRecord | undefined>("readonly", (s) => s.get(key));
      // not this account's: left where it is, for the account it belongs to
      return record && copyReadableBy(key, record, sessionAccount()) ? record : undefined;
    } catch {
      return undefined;
    }
  }

  async function set(key: string, record: LocalListRecord): Promise<void> {
    if (!enabled) return;
    try {
      let stamped = record;
      if (isClaimedKey(key)) {
        // No account to file it under (signed out with the list still on screen,
        // or the session not yet answered): write nothing, rather than a copy
        // anyone could read or one nobody could.
        const account = sessionAccount();
        if (!account) return;
        stamped = { ...record, account };
      }
      // The snapshot is a Vue reactive proxy, which IndexedDB's structured clone
      // rejects (DataCloneError). A JSON round-trip yields the plain, serialisable
      // data we actually want to persist — the record is JSON-safe by construction.
      const plain: LocalListRecord = JSON.parse(JSON.stringify(stamped));
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

  /** The account these were kept for has left: drop the claimed opens' copies,
   *  except any still holding edits that never reached the server. */
  async function delClaimed(): Promise<void> {
    if (!enabled) return;
    try {
      const range = IDBKeyRange.bound(CLAIMED_KEY_PREFIX, `${CLAIMED_KEY_PREFIX}\uffff`);
      const keys = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys(range));
      await Promise.all(
        keys.map(async (key) => {
          // read by key, one at a time: the copy judged is the copy deleted
          const record = await tx<LocalListRecord | undefined>("readonly", (s) => s.get(key));
          if (!record?.pending?.length) await tx("readwrite", (s) => s.delete(key));
        }),
      );
    } catch {
      /* best-effort */
    }
  }

  return { get, set, del, delClaimed };
}
