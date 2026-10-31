// The one canonical export traversal, shared by CSV + Markdown so their row
// order can't drift: folders by sortOrder (array order is insertion order —
// folder drag-reorder only rewrites sortOrder), each folder's top-level rows in
// its chosen sort with nested children attached, then a trailing "Unfiled"
// section of top-level folderless items — matching what the editor and share
// views render. Empty sections are included; exporters skip or flatten them.

import type { Item, ListData } from "../types";
import { bySortOrder, groupItemsByFolder, groupItemsByParent, ungroupedTopLevel } from "../weights";

interface ExportSection {
  name: string;
  rows: { item: Item; children: Item[] }[];
}

export function exportSections(list: Pick<ListData, "folders" | "items">): ExportSection[] {
  // one pass each for children-by-parent and top-level-rows-by-folder, not a per-row
  // or per-folder scan of every item (the same two indexes the editor renders from)
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
    name: "Unfiled",
    rows: ungroupedTopLevel(list.items).sort(bySortOrder).map(row),
  });
  return sections;
}

/** Every row in export order, flattened: a nested child follows its parent, as the
 *  CSV and the plain-text copy both lay it out. */
export function exportOrderedItems(list: Pick<ListData, "folders" | "items">): Item[] {
  return exportSections(list).flatMap((s) => s.rows.flatMap((r) => [r.item, ...r.children]));
}
