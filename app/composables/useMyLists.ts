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

  const all = computed(() =>
    [...entries.value].sort((a, b) => b.lastOpened - a.lastOpened),
  );

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
    });
    return res.editToken;
  }

  return { entries, all, upsert, touch, forget, registerCreated };
}
