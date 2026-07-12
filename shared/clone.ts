import { uid } from "./id";
import type { Folder, Item, ListSnapshot } from "./types";

/**
 * The payload for an independent copy of a list: fresh ids everywhere (so the
 * copy shares nothing with the source), folder→item links remapped, and packed
 * state reset (a copy is a list to pack, not a record of what was packed).
 * Shared by the editor's "Duplicate this list" and the read views' "Copy this
 * list" so the two can't drift.
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
  const items = src.items.map((i) => ({
    ...i,
    id: uid(),
    folderId: i.folderId ? (idMap.get(i.folderId) ?? null) : null,
    packed: false,
  }));
  return { folders, items };
}
