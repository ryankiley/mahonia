// The minimal editor snapshot the ItemRow component tests mount their single
// row against: one folder, no items, grams. Shared by itemPendingEdit +
// itemRename, which each held an identical copy before it lived here.

import type { ListSnapshot } from "../../shared/types";

export function blankList(over: Partial<ListSnapshot> = {}): ListSnapshot {
  return {
    id: "l1",
    name: "Test",
    displayUnit: "g",
    folders: [{ id: "f1", name: "Shelter", sortOrder: 0 }],
    items: [],
    ...over,
  } as unknown as ListSnapshot;
}
