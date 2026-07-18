// The one canonical export traversal, shared by CSV + Markdown so their row
// order can't drift: folders by sortOrder (array order is insertion order —
// folder drag-reorder only rewrites sortOrder), each folder's top-level rows in
// its chosen sort with nested children attached, then a trailing "Ungrouped"
// section of top-level folderless items — matching what the editor and share
// views render. Empty sections are included; exporters skip or flatten them.

import type { Item, ListData } from "../types";
import { bySortOrder, groupItemsByParent, sortedFolderItems, ungroupedTopLevel } from "../weights";

export interface ExportSection {
  name: string;
  rows: { item: Item; children: Item[] }[];
}

export function exportSections(list: Pick<ListData, "folders" | "items">): ExportSection[] {
  // one children-by-parent pass for the whole list, not a per-row childrenOf scan
  const byParent = groupItemsByParent(list.items);
  const row = (item: Item) => ({ item, children: byParent.get(item.id) ?? [] });
  const sections: ExportSection[] = [...list.folders].sort(bySortOrder).map((f) => ({
    name: f.name,
    rows: sortedFolderItems(list.items, f).map(row),
  }));
  sections.push({
    // ungroupedTopLevel is the one shared "not in any folder" predicate the editor
    // and share views use — so exports can't drift from what the app renders
    name: "Ungrouped",
    rows: ungroupedTopLevel(list.items).sort(bySortOrder).map(row),
  });
  return sections;
}
