// The list fixtures every editor suite builds its snapshot from: a snapshot with every
// required field filled, a row with every required field filled, and the one-folder
// blank list the ItemRow component tests mount their single row against. Eleven files
// each carried a snapshot literal and seven an identical `item` factory before they
// lived here; a suite layers what it is actually about through `over`.

import type { Folder, Item, ListSnapshot, ListState } from "../../shared/types";

/** A complete ListSnapshot: no folders, no items, grams, version 1, private. */
export function snapshotFor(over: Partial<ListSnapshot> = {}): ListSnapshot {
  return {
    shareCode: "code",
    slug: "slug",
    title: "List",
    description: "",
    displayUnit: "g",
    folders: [],
    items: [],
    version: 1,
    isPublic: false,
    ...over,
  };
}

/** A reducer state — what applyOps works on — with nothing in it: grams, version 1. */
export function blankState(over: Partial<ListState> = {}): ListState {
  return { title: "Trip", displayUnit: "g", folders: [], items: [], version: 1, ...over };
}

/** The folder a row sits in by default: "Shelter", f1, base, first. */
export const folder = (over: Partial<Folder> = {}): Folder => ({
  id: "f1",
  name: "Shelter",
  defaultClassification: "base",
  sortOrder: 0,
  ...over,
});

/** The ItemRow suites' list: one folder ("Shelter", f1), no items. */
export function blankList(over: Partial<ListSnapshot> = {}): ListSnapshot {
  return snapshotFor({ folders: [folder()], ...over });
}

/** The exporter suites' list: a base folder holding a 538 g "Zpacks Duplex" and a worn
 *  folder holding a 300 g rain jacket. Share code "X", slug "x". */
export function twoFolderList(): ListSnapshot {
  return snapshotFor({
    shareCode: "X",
    slug: "x",
    title: "Trip",
    folders: [folder(), folder({ id: "f2", name: "On Body", defaultClassification: "worn", sortOrder: 1 })],
    items: [
      item({ id: "i1", name: "Zpacks Duplex", unitWeightMg: 538_000 }),
      item({ id: "i2", folderId: "f2", name: "Rain jacket", unitWeightMg: 300_000 }),
    ],
  });
}

/** A row in folder f1 with nothing on it yet: top-level, unnamed, weightless, one of
 *  it, on the folder's classification. The id is the one field a case always picks. */
export const item = (over: Partial<Item> & { id: string }): Item => ({
  folderId: "f1",
  parentId: null,
  name: "",
  unitWeightMg: 0,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

/** A row a vault capture would take: named, branded, weighed, no children. */
export const gear = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: "f1",
  name: "Duplex",
  brand: "Zpacks",
  unitWeightMg: 539_000,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});
