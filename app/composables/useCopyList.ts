import { cloneListData } from "~~/shared/clone";
import { editLinkPath } from "~~/shared/links";
import { pickListMeta, type ListData, type ListMeta, type ListSnapshot } from "~~/shared/types";

/**
 * Mint a list on the server and make it this browser's: the create call, then — in
 * THIS order — the vault capture and the registry row. A list that arrives whole (no
 * ops) has exactly one moment its gear can reach your vault, and it is this one; and
 * it IS yours now, unlike a list someone shared. The copy below and the import dialog
 * both end here (each used to spell the sequence itself, so the ordering lived in two
 * places); the caller navigates, since each has a word to say first.
 */
export async function createAndRegisterList(
  body: Partial<ListMeta> & { data: ListData },
  totalMg = 0,
): Promise<{ snapshot: ListSnapshot; token: string }> {
  const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
    method: "POST",
    body,
  });
  useVaultCapture().captureNewList(res.snapshot, res.editToken);
  const token = useMyLists().registerCreated(res, totalMg);
  return { snapshot: res.snapshot, token };
}

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
      // The list's META rides along, not just its content. Sending title + data
      // alone meant a duplicate came back in GRAMS however the original read, with
      // its description, trail link, distance, route and trip dates all dropped —
      // while cloneListData faithfully copied the days and waypoints that were
      // measured against that route. pickListMeta walks LIST_META_KEYS, so what a
      // copy keeps can't drift from what a list holds.
      // Title last: a copy is named after its source, not by it.
      const { snapshot, token } = await createAndRegisterList(
        {
          ...pickListMeta(src),
          title: `${src.title || "Untitled list"} (copy)`,
          data: cloneListData(src),
        },
        totalMg,
      );
      await navigateTo(editLinkPath(snapshot.shareCode, token));
      return true;
    } catch {
      return false; // offline or rejected — the caller decides how loud to be
    } finally {
      copying.value = false;
    }
  }

  return { copying, copyList };
}
