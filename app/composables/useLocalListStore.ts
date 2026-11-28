import { CLAIMED_KEY_PREFIX, accountSlot, copyReadableBy, isClaimedKey, type LocalListRecord } from "~~/shared/localList";
import { idbRequest } from "~~/shared/idb";
import { sessionAccount, sessionAccountNames } from "../utils/sessionOwner";

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
// So a copy is kept in a slot of its ACCOUNT's (accountSlot), which only that
// account's sessions read or write. The account, not the session: a session is new
// with every sign-in, and edits typed offline have to be there when their person
// comes back, whichever session that is. For the same reason leaving an account
// (delClaimed) drops only the copies with nothing unsent in them; one still
// holding edits waits, unreadable to anyone else, for its account to return.
//
// A slot each, rather than one record per list that the wrong account is refused:
// two accounts can hold the same list, and with one record between them the second
// to open it here would write its copy over the first's unsent edits.
//
// A copy from before the slots sits under the list's own key, stamped with its
// account or, older still, with nothing. It is read by the account it is stamped
// for (by anyone, with no stamp to compare) and moves to the reader's slot as it
// is read, so nothing typed offline is lost to the upgrade.
//
// The same move takes over a copy filed under the marker the account went by before
// markers were stored (sessionAccountNames' `was`): from its slot under that marker,
// or from the list's own key with that marker's stamp. An app shell from before
// still writes there, so that slot can hold a copy while the account's own does too.
// The one with unsent edits is then the one to have: it replaces a copy with nothing
// unsent, and waits where it is, for a later read, behind one that has some.

// ONE READ HELD FOR THE LOAD THAT ASKED FOR IT. The editor page reads the list it is
// opening before the editor mounts (readAhead, useGearList), and the load that follows
// takes the answer from here instead of reading again — with no await once it has
// landed, so the editor's first render already has the list, and the same read still
// in flight when it hasn't, so a slow device doesn't pay for a second one.
// One slot, not a cache, and it belongs to the navigation that filled it. Only a load
// for ITS key takes it: a load for another list in between (a retry, the online watcher)
// passes it by rather than throwing it away from under the open it was read for. And it
// is served only while it's fresh: an open that never came (a navigation cancelled or
// superseded) leaves a read that ages out instead of being handed to some later open of
// that list, whose copy may have been written since by another tab. A write to its key
// here drops it at once.
const HELD_FRESH_MS = 2000; // the read and its load are one navigation apart: ~250 ms at most
type Held = {
  key: string;
  read: Promise<LocalListRecord | undefined>;
  landed?: { record: LocalListRecord | undefined };
  at: number;
};
let held: Held | undefined;
/** Empty the held read — a test seam, so one case's read can't reach the next. */
export function _dropHeldRead(): void {
  held = undefined;
}

export function useLocalListStore() {
  const enabled = import.meta.client && typeof indexedDB !== "undefined";

  const read = (slot: string) => tx<LocalListRecord | undefined>("readonly", (s) => s.get(slot));

  /** Where `key`'s record is kept: under the key itself, or for a claimed open in
   *  its account's slot. That is whoever is signed in, unless the caller names the
   *  account: an open list writes to the account it was opened through, which a
   *  sign-in or sign-out in another tab can have replaced under it. Null for a
   *  claimed open with no account to file it under (the session not yet answered):
   *  nothing is read and nothing written, rather than a copy anyone could read or
   *  one nobody could. */
  function slotFor(key: string, account = sessionAccount()): { slot: string; account?: string } | null {
    if (!isClaimedKey(key)) return { slot: key };
    return account ? { slot: accountSlot(key, account), account } : null;
  }

  async function get(key: string): Promise<LocalListRecord | undefined> {
    if (!enabled) return undefined;
    try {
      if (!isClaimedKey(key)) return await read(key);
      const who = sessionAccountNames();
      if (!who) return undefined;
      const slot = accountSlot(key, who.account);
      const record = await read(slot);
      // Best-effort, and written before the old one is dropped: a move cut short
      // leaves the old copy to be read again, never neither.
      const moveFrom = async (from: string, old: LocalListRecord) => {
        const moved: LocalListRecord = { ...old, account: who.account };
        await tx("readwrite", (s) => s.put(moved, slot))
          .then(() => tx("readwrite", (s) => s.delete(from)))
          .catch(() => {});
        return moved;
      };
      if (who.was && !record?.pending?.length) {
        const from = accountSlot(key, who.was);
        const old = await read(from);
        if (old && (!record || old.pending?.length)) return await moveFrom(from, old);
      }
      if (record) return record;
      // A copy from before the slots. Another account's is left where it is, for
      // the account it belongs to.
      const old = await read(key);
      const theirs = old && (copyReadableBy(key, old, who.account) || (!!who.was && copyReadableBy(key, old, who.was)));
      return old && theirs ? await moveFrom(key, old) : undefined;
    } catch {
      return undefined;
    }
  }

  async function set(key: string, record: LocalListRecord, account?: string): Promise<void> {
    if (held?.key === key) held = undefined;
    if (!enabled) return;
    try {
      const at = slotFor(key, account);
      if (!at) return;
      const stamped = at.account ? { ...record, account: at.account } : record;
      // The snapshot is a Vue reactive proxy, which IndexedDB's structured clone
      // rejects (DataCloneError). A JSON round-trip yields the plain, serialisable
      // data we actually want to persist — the record is JSON-safe by construction.
      const plain: LocalListRecord = JSON.parse(JSON.stringify(stamped));
      await tx("readwrite", (s) => s.put(plain, at.slot));
    } catch {
      /* best-effort */
    }
  }

  /** Drop `key`'s record. For a claimed open that is one account's copy (the
   *  signed-in one's, or `account`'s) and no other: another account's may hold
   *  edits it has yet to send. `keepUnsent` leaves a copy that still holds some, as
   *  delClaimed does: one this page has nothing in may be another tab's, kept with an
   *  edit it couldn't send. */
  async function del(key: string, account?: string, { keepUnsent = false } = {}): Promise<void> {
    if (held?.key === key) held = undefined;
    if (!enabled) return;
    try {
      const at = slotFor(key, account);
      if (!at) return;
      if (keepUnsent && (await read(at.slot))?.pending?.length) return;
      await tx("readwrite", (s) => s.delete(at.slot));
    } catch {
      /* best-effort */
    }
  }

  /** The account these were kept for has left: drop the claimed opens' copies,
   *  whichever account's, except any still holding edits that never reached the
   *  server. So a copy outlives its account's session only while it holds some. */
  async function delClaimed(): Promise<void> {
    if (held && isClaimedKey(held.key)) held = undefined;
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

  /** Read `key` now and hold the read for the next take(). Resolves once it lands. */
  function prefetch(key: string): Promise<void> {
    const h: Held = { key, read: get(key), at: performance.now() };
    held = h;
    // first on the promise, so `landed` is set before anyone awaiting this resumes
    return h.read.then((record) => void (h.landed = { record }));
  }

  /** The read prefetch(key) started, and only once: `landed` if it has. Undefined for
   *  any other key (which leaves it held) or once it has aged out (which drops it), and
   *  the caller reads for itself. */
  function take(key: string): Held | undefined {
    const h = held;
    if (!h) return undefined;
    if (performance.now() - h.at > HELD_FRESH_MS) {
      held = undefined;
      return undefined;
    }
    if (h.key !== key) return undefined;
    held = undefined;
    return h;
  }

  return { get, set, del, delClaimed, prefetch, take };
}
