// What changing a linked row's size writes (shared/catalogSizes): picking another size
// relinks and takes its weight; typing one relinks when the product is sold in it and
// unlinks when it isn't, so a row never says one size while weighing another.
import { describe, expect, it } from "vitest";
import { sizePickPatch, sortSizes, typedSizeNeedsSizes, typedSizePatch, type CatalogSize } from "../shared/catalogSizes";
import { applyOps } from "../shared/ops";
import type { ListSnapshot } from "../shared/types";
import { blankList, item } from "./helpers/list";

const size = (id: number, variant: string | null, grams: number, kcal: number | null = null): CatalogSize => ({
  id,
  variant,
  weightMg: grams * 1000,
  kcal,
});
const SIZES = [size(7, "20F, Regular", 590), size(8, "20F, Long", 640), size(9, "10F, Long", 720)];
// the Regular as a pick lands it: linked, the catalog's words and weight
const regular = (over = {}) =>
  item({
    id: "q",
    brand: "Hammock Gear",
    name: "Burrow Quilt",
    variant: "20F, Regular",
    commonName: "Quilt",
    catalogItemId: 7,
    unitWeightMg: 590_000,
    catalogWeightMgAtLink: 590_000,
    ...over,
  });

describe("sortSizes", () => {
  it("reads numbers as numbers, so 5F comes before 10F", () => {
    const sorted = sortSizes([size(1, "10F", 1), size(2, "5F", 1), size(3, "0F", 1), size(4, null, 1)]);
    expect(sorted.map((s) => s.variant)).toEqual([null, "0F", "5F", "10F"]);
  });
});

describe("sizePickPatch", () => {
  it("relinks to the size and takes its cited weight as the new baseline", () => {
    expect(sizePickPatch(SIZES[1]!)).toEqual({
      catalogItemId: 8,
      variant: "20F, Long",
      unitWeightMg: 640_000,
      catalogWeightMgAtLink: 640_000,
      weightOverridden: false,
      nameOverridden: false,
    });
  });

  it("brings a food size's calories along", () => {
    expect(sizePickPatch(size(3, "Double", 250, 1100)).kcal).toBe(1100);
  });

  it("replaces a weight the person had measured, which was the other size's", () => {
    const list = blankList({ items: [regular({ unitWeightMg: 601_000, weightOverridden: true })] });
    const next = applyOps(list, [{ t: "updateItem", id: "q", patch: sizePickPatch(SIZES[2]!) }]) as ListSnapshot;
    expect(next.items[0]).toMatchObject({ catalogItemId: 9, unitWeightMg: 720_000, catalogWeightMgAtLink: 720_000 });
    expect(next.items[0]!.weightOverridden).toBeFalsy();
    // the product is the same, so its brand, name and gear type stay
    expect(next.items[0]).toMatchObject({ brand: "Hammock Gear", name: "Burrow Quilt", commonName: "Quilt" });
  });
});

describe("typedSizePatch", () => {
  it("relinks a size the product is sold in, however it's spelled", () => {
    expect(typedSizePatch(regular(), "  20f, long ", SIZES)).toEqual(sizePickPatch(SIZES[1]!));
  });

  it("unlinks a size the product isn't sold in, keeping the weight as the person's", () => {
    expect(typedSizePatch(regular(), "30F, Long", SIZES)).toEqual({
      variant: "30F, Long",
      catalogItemId: null,
      nameOverridden: true,
      weightOverridden: true,
    });
  });

  it("unlinks when the sizes couldn't be had, since the link's weight is for the old size", () => {
    expect(typedSizePatch(regular(), "20F, Long", null)).toMatchObject({ catalogItemId: null, variant: "20F, Long" });
  });

  it("writes nothing for the size the row already says", () => {
    expect(typedSizePatch(regular(), "20f, regular", SIZES)).toBeNull();
  });

  it("keeps the link when the size is cleared", () => {
    expect(typedSizePatch(regular(), "  ", SIZES)).toEqual({ variant: "", nameOverridden: true });
  });

  it("puts a drifted row back on its own link by typing the size it is linked to", () => {
    // what the old field could leave: linked to the Regular, saying Long, weighing the Regular
    const drifted = regular({ variant: "Long", nameOverridden: true });
    expect(typedSizePatch(drifted, "20F, Regular", SIZES)).toEqual(sizePickPatch(SIZES[0]!));
  });

  it("stores an unlinked row's size as text", () => {
    const typed = item({ id: "t", name: "Tarp" });
    expect(typedSizePatch(typed, "8 x 10", null)).toEqual({ variant: "8 x 10", nameOverridden: true });
    expect(typedSizePatch(typed, "", null)).toBeNull();
  });

  it("drops the old baseline through the reducer when it unlinks", () => {
    const list = blankList({ items: [regular()] });
    const patch = typedSizePatch(regular(), "30F, Long", SIZES)!;
    const next = applyOps(list, [{ t: "updateItem", id: "q", patch }]) as ListSnapshot;
    expect(next.items[0]!.catalogItemId).toBeUndefined();
    expect(next.items[0]!.catalogWeightMgAtLink).toBeUndefined();
    expect(next.items[0]).toMatchObject({ variant: "30F, Long", unitWeightMg: 590_000, brand: "Hammock Gear" });
  });
});

describe("typedSizeNeedsSizes", () => {
  it("asks for the sizes only when a linked row says a different size", () => {
    expect(typedSizeNeedsSizes(regular(), "20F, Long")).toBe(true);
    expect(typedSizeNeedsSizes(regular(), "20F, regular")).toBe(false);
    expect(typedSizeNeedsSizes(regular(), "")).toBe(false);
    expect(typedSizeNeedsSizes(item({ id: "t", name: "Tarp" }), "8 x 10")).toBe(false);
  });
});
