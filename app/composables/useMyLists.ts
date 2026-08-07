import type { Ref } from "vue";
import type { ListSnapshot, MyListEntry } from "~~/shared/types";

// No-login "My Lists": the registry of edit tokens this browser holds. This is
// the only thing tying a visitor to their lists — clear the browser and they're
// gone unless the edit link was saved elsewhere.
const STORAGE_KEY = "gear.mylists.v1";

// Hand-rolled localStorage-backed ref (was @vueuse/core's useStorage — see
// app/composables/dom.ts for why the library left). The server/prerender pass
// sees an empty registry; the client seeds it from localStorage at setup.
// Every mutation below REASSIGNS entries.value rather than mutating the array
// in place (the repo-wide rule a deep watcher once forced), so a plain shallow
// watch persists reliably. The "storage" event keeps a second open tab in sync;
// it only fires on OTHER tabs and only when the stored string actually changed,
// so echoing the read back through the watcher can't loop.
function readEntries(): MyListEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MyListEntry[]) : [];
  } catch {
    return [];
  }
}

let _entries: Ref<MyListEntry[]> | undefined;

function storageEntries(): Ref<MyListEntry[]> {
  const entries = ref<MyListEntry[]>([]);
  if (import.meta.client) {
    entries.value = readEntries();
    // A DETACHED scope, for the same reason useGearList's controller has one: the
    // ref above is a module singleton, but the first useMyLists() call comes from
    // whichever component mounts first — so a bare watch() registers in THAT
    // component's effect scope and Vue stops it on that component's unmount. The
    // registry then goes on living in memory with no writer behind it, and every
    // later mutation updates the screen and nothing else.
    //
    // That is how a list became impossible to get rid of. The editor calls
    // useMyLists() first; /mine is only reachable by leaving the editor, which
    // unmounts it and takes the watcher with it. "Remove from device" then dropped
    // the row on screen, wrote nothing, and the next load read the old registry
    // back. "Delete" was worse: the server delete went through, so the list was
    // really gone, and the row it left behind pointed at a dead list forever.
    effectScope(true).run(() => {
      watch(entries, (v) => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
        } catch {
          // storage full/blocked — keep the in-memory registry working
        }
      });
    });
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) entries.value = readEntries();
    });
  }
  return entries;
}

export function useMyLists() {
  if (!_entries) _entries = storageEntries();
  const entries = _entries;

  // ONE ROW PER LIST. The registry is stored per edit token, but a token is a
  // capability, not an identity — the list is the SHARE CODE. Rotating a list's link
  // mints a second token for the same list, so matching on the token alone left both
  // rows standing whenever the rotate's `forget` didn't reach localStorage (a second
  // tab's stale write clobbering it, or storage rejecting it). What you saw then was
  // the same pack twice in the switcher, both rows marked as the one you're in, one
  // of them a link the server had already killed — and no way to tell which.
  //
  // Every caller here is holding a token the server has just accepted (create, clone,
  // import, a confirmed open, a rotate), so the incoming entry is the live one: it
  // claims the share code, and any older row for that list steps aside. That makes
  // the duplicate self-healing — open the list once and the leftover is gone.
  //
  // Non-empty codes only: entries from before pretty links (#54) have none, and
  // "" === "" would collapse every one of them into a single row.
  function upsert(e: MyListEntry) {
    const isSameList = (x: MyListEntry) =>
      x.editToken === e.editToken || (!!e.shareCode && x.shareCode === e.shareCode);
    // Preserve a stronger origin: a list you made and later reopen through its own
    // link must not be downgraded to "opened" by that reopen — and reading across
    // EVERY row being replaced means a rotate can't launder it away either, which
    // would quietly stop the list being attached to your account on sign-in.
    const prior = entries.value.filter(isSameList);
    const origin = prior.some((x) => x.origin === "created")
      ? "created"
      : // the first row that HAS one, not simply the first row: with two being
        // replaced their array order is incidental, and inheriting an absent origin
        // over a present "opened" would quietly make a shared list claimable
        (e.origin ?? prior.find((x) => x.origin)?.origin);
    entries.value = [...entries.value.filter((x) => !isSameList(x)), { ...e, origin }];
  }

  function touch(editToken: string, patch: Partial<MyListEntry>) {
    entries.value = entries.value.map((x) =>
      x.editToken === editToken ? { ...x, ...patch, lastOpened: Date.now() } : x,
    );
  }

  function forget(editToken: string) {
    entries.value = entries.value.filter((x) => x.editToken !== editToken);
    // drop this list's on-device snapshot/queue too (rotate re-keys; explicit
    // removal cleans up) so a forgotten token leaves nothing behind in IndexedDB
    useLocalListStore().del(editToken);
  }

  /**
   * The other side of the share-code claim in `upsert`.
   *
   * Called when the server has just 404'd this token — it is dead, rotated away or
   * deleted. That alone says nothing: a list you really did delete keeps its row
   * until you clear it on /mine, and the on-device copy stays readable here. But if
   * the registry holds ANOTHER row for the SAME list, this one is the leftover half
   * of a rotate, and the live row beside it is the list. Drop it.
   *
   * With `upsert` healing from the live side and this from the dead one, either of
   * two identical-looking rows clears the duplicate — which matters, because from
   * the switcher there is no way to tell them apart.
   *
   * Unlike `forget`, the on-device copy STAYS. The ROW is what's broken; the copy
   * under a dead token can hold edits that never reached the server (a second tab
   * that kept editing after the rotate), and the page that opened it is still
   * showing them — "No longer online · saved on device" is a promise to keep.
   *
   * Returns whether a row was dropped.
   */
  function forgetSuperseded(editToken: string): boolean {
    const mine = entries.value.find((x) => x.editToken === editToken);
    // no row, or a legacy entry with no share code — nothing that can be proven
    // superseded, since "" === "" is not "the same list"
    if (!mine?.shareCode) return false;
    const hasLiveRow = entries.value.some(
      (x) => x.editToken !== editToken && x.shareCode === mine.shareCode,
    );
    if (!hasLiveRow) return false;
    entries.value = entries.value.filter((x) => x.editToken !== editToken);
    return true;
  }

  // Delete the list on the server (soft-delete — it drops out of every lookup at
  // once, the nightly purge reclaims it), then forget it locally. A 404 means it
  // was already gone server-side, so we still forget it. Any other failure
  // (offline) leaves the entry so the user can retry. Returns whether it's gone.
  async function deleteList(editToken: string): Promise<boolean> {
    try {
      await $fetch("/api/edit/delete", {
        method: "POST",
        headers: { Authorization: `Bearer ${editToken}` },
      });
    } catch (e) {
      if ((e as { statusCode?: number })?.statusCode !== 404) return false;
    }
    forget(editToken);
    return true;
  }

  // Register a freshly created/imported/cloned list in this browser's registry.
  // Returns the edit token so the caller can navigate straight to /e#{token}.
  function registerCreated(
    res: { editToken: string; snapshot: ListSnapshot },
    totalMg = 0,
    origin: "created" | "opened" = "created",
  ): string {
    upsert({
      origin,
      editToken: res.editToken,
      shareCode: res.snapshot.shareCode,
      slug: res.snapshot.slug,
      title: res.snapshot.title,
      totalMg,
      version: res.snapshot.version,
      lastOpened: Date.now(),
      displayUnit: res.snapshot.displayUnit,
    });
    return res.editToken;
  }

  return { entries, upsert, touch, forget, forgetSuperseded, deleteList, registerCreated };
}
