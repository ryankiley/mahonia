import { uid } from "./id";
import type { Folder, Item, ListSnapshot } from "./types";

/**
 * The payload for an independent copy of a list: fresh ids everywhere (so the
 * copy shares nothing with the source), folder→item and parent→child links
 * remapped, and packed state reset (a copy is a list to pack, not a record of
 * what was packed). Shared by the editor's "Duplicate this list" and the read
 * views' "Copy this list" so the two can't drift.
 */
export function cloneListData(
  src: Pick<ListSnapshot, "folders" | "items">,
): { folders: Folder[]; items: Item[] } {
  const idMap = new Map<string, string>();
  const folders = src.folders.map((f) => {
    const nid = uid();
    idMap.set(f.id, nid);
    return { ...f, id: nid };
  });
  // Two passes (mirrors jsonToListImport) so a child can re-point its parentId even
  // when the parent appears later in the array; a dangling parent degrades to
  // top-level, not a broken link that would render nowhere yet count in totals.
  const itemIdMap = new Map<string, string>();
  const newIds = src.items.map((i) => {
    const nid = uid();
    if (!itemIdMap.has(i.id)) itemIdMap.set(i.id, nid);
    return nid;
  });
  const items = src.items.map((i, k) => ({
    ...i,
    id: newIds[k]!,
    folderId: i.folderId ? (idMap.get(i.folderId) ?? null) : null,
    parentId: i.parentId ? (itemIdMap.get(i.parentId) ?? null) : null,
    packed: false,
  }));
  return { folders, items };
}
