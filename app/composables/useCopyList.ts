import { cloneListData } from "~~/shared/clone";
import { editLinkPath } from "~~/shared/links";
import type { ListSnapshot } from "~~/shared/types";

/**
 * The tail every whole-list mint shares (the copy path below and the import
 * dialog): capture the new list for the vault, register it in this browser's
 * "my lists", and land in its editor. A list minted whole arrives with no ops,
 * so this is the one moment its gear can reach your vault — and it IS yours,
 * unlike a list someone merely shared with you.
 */
export async function enterCreatedList(
  res: { editToken: string; snapshot: ListSnapshot },
  totalMg = 0,
): Promise<void> {
  useVaultCapture().captureNewList(res.snapshot, res.editToken);
  const token = useMyLists().registerCreated(res, totalMg);
  await navigateTo(editLinkPath(res.snapshot.shareCode, token));
}

// The one create-a-copy path: mint an independent list from a snapshot, register
// it in this browser's "my lists", and land in its editor. Used by the editor's
// "Duplicate this list" and the read views' "Copy this list" — the read pages pull
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
          body: { title: `${src.title || "Untitled list"} (copy)`, data: cloneListData(src) },
        },
      );
      await enterCreatedList(res, totalMg);
      return true;
    } catch {
      return false; // offline or rejected — the caller decides how loud to be
    } finally {
      copying.value = false;
    }
  }

  return { copying, copyList };
}
