// Per-id collapse state that outlives the page — a folder, a nested group, a trip
// day — kept in localStorage under `${prefix}${id}` and read through ONE module-level
// cache rather than straight off storage.
//
// Pure UI state, never sent to the server: it's how YOU are looking at the list, not a
// fact about it. Four surfaces remember a collapse this way (the editor's folders and
// nested groups, /gear's folders, the plan's days), and each carried its own copy of
// the read, the write and the storage fallback; this is that copy, once. Every caller
// keeps its own key namespace — gear.fold.*, gear.nest.*, gear.vfold.*, gear.day.* —
// so nobody's remembered state moved when the code did.
//
// WHY A CACHE: storage is synchronous, and every row reads its own key on mount — so
// a mode switch, which remounts the whole list, was paying one blocking read per row
// for an answer that only this app ever writes. Cached on first read and kept in step
// by set(), so the value is still exactly what's on disk.
//
// A cache that never re-read would out-live the truth: `storage` fires in the OTHER
// tabs, so the same list open twice would keep showing its own stale collapse state on
// the next remount. Dropping the entry sends the next read back to disk — which is
// exactly what happened before the cache existed.
const cache = new Map<string, boolean>();
let listening = false;
function listen() {
  if (listening || !import.meta.client) return;
  listening = true;
  window.addEventListener("storage", (e) => {
    if (e.key === null) cache.clear(); // storage.clear() in another tab
    else if (cache.has(e.key)) cache.delete(e.key);
  });
}

export function usePersistedCollapse(prefix: string) {
  listen();
  const keyFor = (id: string | number) => `${prefix}${id}`;

  /** Collapsed? Read from the cache, else from disk once. Storage blocked (private
   *  mode) answers false — default expanded — the same as every caller decided. */
  function isCollapsed(id: string | number): boolean {
    const key = keyFor(id);
    let v = cache.get(key);
    if (v === undefined) {
      // recall() (app/utils/remember) answers null where storage is blocked
      v = recall(key) === "1";
      cache.set(key, v);
    }
    return v;
  }

  /** Record it. "1" collapsed; an absent key is expanded, so collapsing back open
   *  drops the key rather than writing a "0" that reads the same. */
  function set(id: string | number, on: boolean): void {
    const key = keyFor(id);
    cache.set(key, on);
    if (on) remember(key, "1");
    else forget(key);
  }

  /** Flip it, and answer the new state. */
  function toggle(id: string | number): boolean {
    const next = !isCollapsed(id);
    set(id, next);
    return next;
  }

  return { isCollapsed, set, toggle };
}
