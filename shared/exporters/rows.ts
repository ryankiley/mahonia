// The one canonical export traversal, shared by CSV + Markdown so their row
// order can't drift: folders by sortOrder (array order is insertion order —
// folder drag-reorder only rewrites sortOrder), each folder's top-level rows in
// its chosen sort with nested children attached, then a trailing "Ungrouped"
// section of top-level folderless items — matching what the editor and share
// views render. Empty sections are included; exporters skip or flatten them.

import type { Folder, Item, ListData } from "../types";
import { bySortOrder, groupItemsByFolder, groupItemsByParent, ungroupedTopLevel } from "../weights";

export interface ExportSection {
  name: string;
  rows: { item: Item; children: Item[] }[];
}

export function exportSections(list: Pick<ListData, "folders" | "items">): ExportSection[] {
  // one children-by-parent pass and one top-level-rows-by-folder pass for the whole
  // list — the same groupings the editor renders from — rather than a scan of every
  // item per folder and per row
  const byParent = groupItemsByParent(list.items);
  const byFolder = groupItemsByFolder(list.items);
  const row = (item: Item) => ({ item, children: byParent.get(item.id) ?? [] });
  const sections: ExportSection[] = [...list.folders].sort(bySortOrder).map((f) => ({
    name: f.name,
    rows: (byFolder.get(f.id) ?? []).map(row),
  }));
  sections.push({
    // ungroupedTopLevel is the one shared "not in any folder" predicate the editor
    // and share views use — so exports can't drift from what the app renders
    name: "Ungrouped",
    rows: ungroupedTopLevel(list.items).sort(bySortOrder).map(row),
  });
  return sections;
}

/** Every item in export order, flattened: each top-level row immediately followed
 *  by its nested children, folder after folder, the ungrouped tail last. The
 *  traversal the CSV and the plain-text export share — both are flat formats, so
 *  a child's only claim to its parent is adjacency. */
export function exportRowsFlat(list: Pick<ListData, "folders" | "items">): Item[] {
  return exportSections(list).flatMap((s) => s.rows.flatMap((r) => [r.item, ...r.children]));
}

/** Folder id → folder, built once per export so the per-row classification and
 *  folder-name lookups don't each scan the folder array. */
export function foldersById(folders: readonly Folder[]): Map<string, Folder> {
  return new Map(folders.map((f) => [f.id, f]));
}
