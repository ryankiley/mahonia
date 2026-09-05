import { cloneListData } from "~~/shared/clone";
import { editLinkPath } from "~~/shared/links";
import { pickListMeta, type ListSnapshot } from "~~/shared/types";

// The one create-a-copy path: mint an independent list from a snapshot, register
// it in this browser's "my lists", and land in its editor. Used by the editor's
// "Duplicate this list" and the read views' identical item — the read pages pull
// only this thin module (clone + links + the registry), never the editor graph.
export function useCopyList() {
  const copying = ref(false);

  /** Returns true once navigation to the new list's editor has begun. */
  async function copyList(src: ListSnapshot, totalMg = 0): Promise<boolean> {
    if (copying.value) return false;
    copying.value = true;
    try {
      const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>(
        "/api/lists/create",
        {
          method: "POST",
          // The list's META rides along, not just its content. Sending title + data
          // alone meant a duplicate came back in GRAMS however the original read, with
          // its description, trail link, distance, route and trip dates all dropped —
          // while cloneListData faithfully copied the days and waypoints that were
          // measured against that route. pickListMeta walks LIST_META_KEYS, so what a
          // copy keeps can't drift from what a list holds.
          // Title last: a copy is named after its source, not by it.
          body: {
            ...pickListMeta(src),
            title: `${src.title || "Untitled list"} (copy)`,
            data: cloneListData(src),
          },
        },
      );
      // a clone arrives whole (no ops), so this is the one moment its gear can
      // reach your vault — and it IS yours now, unlike a list someone shared
      useVaultCapture().captureNewList(res.snapshot, res.editToken);
      const token = useMyLists().registerCreated(res, totalMg);
      await navigateTo(editLinkPath(res.snapshot.shareCode, token));
      return true;
    } catch {
      return false; // offline or rejected — the caller decides how loud to be
    } finally {
      copying.value = false;
    }
  }

  return { copying, copyList };
}
