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
    watch(entries, (v) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
      } catch {
        // storage full/blocked — keep the in-memory registry working
      }
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

  function upsert(e: MyListEntry) {
    const next = entries.value.filter((x) => x.editToken !== e.editToken);
    next.push(e);
    entries.value = next;
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
  ): string {
    upsert({
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

  return { entries, upsert, touch, forget, deleteList, registerCreated };
}
