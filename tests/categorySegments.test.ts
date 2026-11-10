import { describe, expect, it } from "vitest";
import { categorySegments } from "../shared/categorySegments";
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
  it("returns nothing for a weightless list (weight is optional)", () => {
    const empty: ListData = {
      folders: [{ id: "f1", name: "X", defaultClassification: "base", sortOrder: 0 }],
      items: [{ id: "i1", folderId: "f1", name: "Thing", unitWeightMg: 0, qty: 1, classification: null, sortOrder: 0 }],
    };
    expect(categorySegments(empty)).toEqual([]);
  });
});
