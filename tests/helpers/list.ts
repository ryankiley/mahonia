// Snapshot fixtures the exporter and component suites build on. Each lived as an
// identical copy in two test files before it was here.

import type { ListSnapshot } from "../../shared/types";

/** Two folders (a base one and a worn one), one weighed item in each, grams — what
 *  the CSV and Markdown exporter suites round-trip and mutate. A fresh object per
 *  call, since the cases push into it. */
export const sampleSnapshot = (): ListSnapshot => ({
  shareCode: "X",
  slug: "x",
  version: 1,
  isPublic: false,
  title: "Trip",
  displayUnit: "g",
  folders: [
    { id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 },
    { id: "f2", name: "On Body", defaultClassification: "worn", sortOrder: 1 },
  ],
  items: [
    { id: "i1", folderId: "f1", name: "Zpacks Duplex", unitWeightMg: 538000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i2", folderId: "f2", name: "Rain jacket", unitWeightMg: 300000, qty: 1, classification: null, sortOrder: 0 },
  ],
});

/** The minimal editor snapshot the ItemRow component tests mount their single
 *  row against: one folder, no items, grams. */

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
