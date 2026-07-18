import { describe, expect, it } from "vitest";
import { cloneListData } from "../shared/clone";
import type { ListSnapshot } from "../shared/types";

// A source list shaped like a real one: two folders, a foldered item, an
// ungrouped item, an orphaned folderId, and a packed checklist state.
const src = (): Pick<ListSnapshot, "folders" | "items"> => ({
  folders: [
    { id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 },
    { id: "f2", name: "Sleep", defaultClassification: "base", sortOrder: 1 },
  ],
  items: [
    { id: "i1", folderId: "f1", name: "Tent", unitWeightMg: 1_000_000, qty: 1, classification: null, sortOrder: 0, packed: true, description: "seam-sealed" },
    { id: "i2", folderId: null, name: "Headlamp", unitWeightMg: 50_000, qty: 1, classification: null, sortOrder: 1 },
    { id: "i3", folderId: "gone", name: "Mug", unitWeightMg: 30_000, qty: 1, classification: null, sortOrder: 2, packed: true },
  ],
});

describe("cloneListData — an independent copy of a list", () => {
  it("mints fresh ids everywhere and remaps folder→item links", () => {
    const s = src();
    const out = cloneListData(s);

    const oldIds = new Set([...s.folders.map((f) => f.id), ...s.items.map((i) => i.id)]);
    for (const f of out.folders) expect(oldIds.has(f.id)).toBe(false);
    for (const i of out.items) expect(oldIds.has(i.id)).toBe(false);

    // the Tent still lives in the (re-idified) Shelter folder
    const shelter = out.folders.find((f) => f.name === "Shelter")!;
    expect(out.items.find((i) => i.name === "Tent")!.folderId).toBe(shelter.id);
    // ungrouped stays ungrouped; a dangling folderId degrades to ungrouped, not a broken link
    expect(out.items.find((i) => i.name === "Headlamp")!.folderId).toBeNull();
    expect(out.items.find((i) => i.name === "Mug")!.folderId).toBeNull();
  });

  it("keeps content (names, weights, notes) but resets packed state", () => {
    const out = cloneListData(src());
    const tent = out.items.find((i) => i.name === "Tent")!;
    expect(tent.unitWeightMg).toBe(1_000_000);
    expect(tent.description).toBe("seam-sealed");
    for (const i of out.items) expect(i.packed).toBe(false);
  });

  it("re-points a nested child's parentId to its parent's NEW id; a dangling parent degrades to top-level", () => {
    const out = cloneListData({
      folders: [{ id: "f1", name: "Shelter", defaultClassification: "base", sortOrder: 0 }],
      items: [
        // child listed BEFORE its parent — the remap must not depend on array order
        { id: "c1", folderId: "f1", parentId: "p1", name: "Fly", unitWeightMg: 1000, qty: 1, classification: null, sortOrder: 0 },
        { id: "p1", folderId: "f1", name: "Tent", unitWeightMg: 1000, qty: 1, classification: null, sortOrder: 1 },
        { id: "c2", folderId: "f1", parentId: "gone", name: "Orphan", unitWeightMg: 1000, qty: 1, classification: null, sortOrder: 2 },
      ],
    });
    const tent = out.items.find((i) => i.name === "Tent")!;
    expect(out.items.find((i) => i.name === "Fly")!.parentId).toBe(tent.id);
    expect(out.items.find((i) => i.name === "Orphan")!.parentId).toBeNull();
    expect(tent.parentId).toBeNull();
  });

  it("leaves the source untouched", () => {
    const s = src();
    cloneListData(s);
    expect(s.items.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
    expect(s.items[0]!.packed).toBe(true);
    expect(s.folders[0]!.id).toBe("f1");
  });
});
