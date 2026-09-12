import { cloneListData } from "~~/shared/clone";
import { editLinkPath } from "~~/shared/links";
import { pickListMeta, type ListSnapshot } from "~~/shared/types";

// The one create-a-copy path: mint an independent list from a snapshot, register
// it in this browser's "my lists", and land in its editor. Used by the editor's
// "Duplicate this list" and the read views' identical item — the read pages pull
// only this thin module (clone + links + the registry), never the editor graph.
export function useCopyList() {
  const copying = ref(false);
  // A list belongs to this device rather than an account, but the one-time vault
  // capture that follows its creation does not. Remember the account lifetime at
  // the start of the operation: A → B can stay signed in throughout a slow create
  // request, so `hasVault` alone cannot tell whose vault would receive the copy.
  const vaultAccess = useVaultAccess();
  const accountGeneration = vaultAccess.accountGeneration ?? useSession().accountGeneration;
  watch(accountGeneration, () => {
    copying.value = false;
  });

  /** Returns true once navigation to the new list's editor has begun. */
  async function copyList(src: ListSnapshot, totalMg = 0): Promise<boolean> {
    if (copying.value) return false;
    copying.value = true;
    const account = accountGeneration.value;
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
      // The list response belongs to the device, but every visible consequence of
      // this click belongs to the person who clicked it. Do not close/navigate or
      // register A's late result once B owns the account surface.
      if (account !== accountGeneration.value) return false;
      // a clone arrives whole (no ops), so this is the one moment its gear can
      // reach your vault — and it IS yours now, unlike a list someone shared.
      // If the session changed while creation was in flight, it was still A who
      // began the copy; never turn that delayed response into B's capture.
      useVaultCapture().captureNewList(res.snapshot, res.editToken, account);
      const token = useMyLists().registerCreated(res, totalMg);
      await navigateTo(editLinkPath(res.snapshot.shareCode, token));
      return true;
    } catch {
      return false; // offline or rejected — the caller decides how loud to be
    } finally {
      if (account === accountGeneration.value) copying.value = false;
    }
  }

  return { copying, copyList };
}
