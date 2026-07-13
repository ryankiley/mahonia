import { useStorage } from "@vueuse/core";
import type { ListSnapshot, MyListEntry } from "~~/shared/types";

// No-login "My Lists": the registry of edit tokens this browser holds. This is
// the only thing tying a visitor to their lists — clear the browser and they're
// gone unless the edit link was saved elsewhere.
const STORAGE_KEY = "gear.mylists.v1";

let _entries: ReturnType<typeof useStorage<MyListEntry[]>> | undefined;

export function useMyLists() {
  if (!_entries) _entries = useStorage<MyListEntry[]>(STORAGE_KEY, []);
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
