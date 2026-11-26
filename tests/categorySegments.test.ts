import { describe, expect, it } from "vitest";
import { categorySegments, displacedIds } from "../shared/categorySegments";
import type { ListData } from "../shared/types";

const dataWithWeights = (): ListData => ({
  folders: [
    { id: "f1", name: "Shelter", colorKey: "shelter", defaultClassification: "base", sortOrder: 0 },
    { id: "f2", name: "Sleep", colorKey: "sleep", defaultClassification: "base", sortOrder: 1 },
    { id: "f3", name: "Pack", colorKey: "pack", defaultClassification: "base", sortOrder: 2 },
    { id: "f4", name: "Kitchen", colorKey: "kitchen", defaultClassification: "base", sortOrder: 3 },
  ],
  items: [
    { id: "i1", folderId: "f1", name: "Tent", unitWeightMg: 500_000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i2", folderId: "f2", name: "Quilt", unitWeightMg: 400_000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i3", folderId: "f3", name: "Pack", unitWeightMg: 300_000, qty: 1, classification: null, sortOrder: 0 },
    { id: "i4", folderId: "f4", name: "Stove", unitWeightMg: 100_000, qty: 1, classification: null, sortOrder: 0 },
  ],
});

describe("category segments (CategoryBar's data)", () => {
  it("sums folder weights, heaviest first", () => {
    const segs = categorySegments(dataWithWeights());
    expect(segs.map((s) => s.colorKey)).toEqual(["shelter", "sleep", "pack", "kitchen"]);
    expect(segs[0]).toMatchObject({ name: "Shelter", mg: 500_000 });
  });
  it("names each segment by its folder, whatever order the weights put it in", () => {
    const data = dataWithWeights();
    expect(categorySegments(data).map((s) => s.id)).toEqual(["f1", "f2", "f3", "f4"]);
    // the stove's folder overtakes the rest: the order changes, the ids go with their folders
    data.items.push({ id: "i5", folderId: "f4", name: "Pot", unitWeightMg: 900_000, qty: 1, classification: null, sortOrder: 1 });
    data.items.push({ id: "i6", folderId: null, name: "Loose", unitWeightMg: 50_000, qty: 1, classification: null, sortOrder: 0 });
    expect(categorySegments(data).map((s) => s.id)).toEqual(["f4", "f1", "f2", "f3", ""]);
  });
  it("returns nothing for a weightless list (weight is optional)", () => {
    const empty: ListData = {
      folders: [{ id: "f1", name: "X", defaultClassification: "base", sortOrder: 0 }],
      items: [{ id: "i1", folderId: "f1", name: "Thing", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 }],
    };
    expect(categorySegments(empty)).toEqual([]);
  });
});

describe("which segments changed places", () => {
  it("is nothing when the order held", () => {
    expect(displacedIds(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
    expect(displacedIds([], ["a", "b"])).toEqual([]);
  });
  it("is the one that climbed, not the ones it passed", () => {
    expect(displacedIds(["a", "b", "c", "d"], ["d", "a", "b", "c"])).toEqual(["d"]);
    expect(displacedIds(["a", "b", "c", "d"], ["b", "c", "d", "a"])).toEqual(["a"]);
  });
  it("leaves out a segment that arrived or left", () => {
    expect(displacedIds(["a", "b", "c"], ["new", "a", "c"])).toEqual([]);
    expect(displacedIds(["a", "b", "c"], ["c", "new", "a"])).toHaveLength(1);
  });
});
