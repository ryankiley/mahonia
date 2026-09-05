import { describe, expect, it } from "vitest";
import {
  applyCatalogMatch,
  buildCatalogNameIndex,
  catalogNameKeys,
  importedNameKey,
  linkImportedItems,
  lookupImported,
} from "../shared/catalogMatch";
import type { CatalogSearchResult } from "../shared/catalogSearch";
import type { Item } from "../shared/types";

// Exact-match linking of imported rows to catalog products. The rule under test is
// "word for word, or nothing": a LighterPack row that spells a product the way the
// catalog does behaves as if picked; anything looser stays a custom row.

const row = (over: Partial<CatalogSearchResult> = {}): CatalogSearchResult => ({
  id: 1,
  brand: "MSR",
  name: "PocketRocket 2 Stove",
  variant: null,
  weightMg: 73_000,
  weightSource: "manufacturer",
  verified: true,
  searchTerms: "stove",
  commonName: "Stove",
  categoryHint: "cook",
  kcal: null,
  ...over,
});
const item = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: "f1",
  name: "MSR PocketRocket 2 Stove",
  unitWeightMg: 73_000,
  qty: 1,
  classification: null,
  ...over,
});

describe("catalogNameKeys / importedNameKey", () => {
  it("answers to brand + model, and to the same with the variant on the end", () => {
    expect(catalogNameKeys(row({ variant: "Regular" }))).toEqual(["msr pocketrocket 2 stove", "msr pocketrocket 2 stove regular"]);
    expect(catalogNameKeys(row({ brand: null, name: "Generic stake" }))).toEqual(["generic stake"]);
  });
  it("folds an imported row the same way, whether its brand is in the name or its own column", () => {
    expect(importedNameKey({ name: "MSR PocketRocket 2 Stove" })).toBe("msr pocketrocket 2 stove");
    expect(importedNameKey({ name: "PocketRocket 2 Stove", brand: "MSR" })).toBe("msr pocketrocket 2 stove");
    expect(importedNameKey({ name: "Tensor All-Season", brand: "Nemo", variant: "Regular" })).toBe("nemo tensor all season regular");
    expect(importedNameKey({ name: "  Msr   Pocketrocket-2 Stove " })).toBe("msr pocketrocket 2 stove");
  });
});

describe("buildCatalogNameIndex / lookupImported", () => {
  it("finds an exact spelling and nothing looser", () => {
    const index = buildCatalogNameIndex([row()]);
    expect(lookupImported(index, { name: "msr pocketrocket 2 stove" })?.id).toBe(1);
    expect(lookupImported(index, { name: "PocketRocket 2" })).toBeNull();
    expect(lookupImported(index, { name: "MSR PocketRocket 2 Stove Deluxe" })).toBeNull();
    expect(lookupImported(index, { name: "" })).toBeNull();
  });
  it("keeps the plus that tells a product from its successor", () => {
    const index = buildCatalogNameIndex([
      row({ id: 1, brand: "Durston", name: "X-Mid Pro 2", variant: "DCF" }),
      row({ id: 2, brand: "Durston", name: "X-Mid Pro 2+", variant: "DCF" }),
    ]);
    expect(lookupImported(index, { name: "Durston X-Mid Pro 2 DCF" })?.id).toBe(1);
    expect(lookupImported(index, { name: "Durston X-Mid Pro 2+ DCF" })?.id).toBe(2);
  });

  it("refuses a key two rows claim rather than guess", () => {
    // "Tensor" + variant "Regular" and a row named "Tensor Regular" spell the same thing
    const index = buildCatalogNameIndex([
      row({ id: 1, name: "Tensor", variant: "Regular" }),
      row({ id: 2, name: "Tensor Regular" }),
    ]);
    expect(lookupImported(index, { name: "MSR Tensor Regular" })).toBeNull();
    // the key only the first row claims still works
    expect(lookupImported(index, { name: "MSR Tensor" })?.id).toBe(1);
  });
});

describe("applyCatalogMatch", () => {
  it("links the row and keeps the import's own weight, marked overridden when it differs", () => {
    const out = applyCatalogMatch(item({ unitWeightMg: 75_000 }), row());
    expect(out).toMatchObject({
      brand: "MSR",
      name: "PocketRocket 2 Stove",
      catalogItemId: 1,
      catalogWeightMgAtLink: 73_000,
      unitWeightMg: 75_000,
      weightOverridden: true,
      nameOverridden: false,
      commonName: "Stove",
    });
  });
  it("gives a weightless row the cited weight, not overridden", () => {
    const out = applyCatalogMatch(item({ unitWeightMg: 0 }), row());
    expect(out.unitWeightMg).toBe(73_000);
    expect(out.weightOverridden).toBe(false);
  });
  it("keeps an explicit gear type and calorie figure, fills them only when absent", () => {
    const food = row({ id: 9, brand: "Clif", name: "Bar", categoryHint: "consumable", kcal: 250, commonName: "Bar" });
    expect(applyCatalogMatch(item({ commonName: "Snack", kcal: 240 }), food)).toMatchObject({ commonName: "Snack", kcal: 240, classification: "consumable" });
    expect(applyCatalogMatch(item(), food)).toMatchObject({ commonName: "Bar", kcal: 250, classification: "consumable" });
  });
  it("leaves a non-consumable hint to the folder default", () => {
    expect(applyCatalogMatch(item({ classification: null }), row()).classification).toBeNull();
  });
});

describe("linkImportedItems", () => {
  it("links what the answer recognises, skips linked and nameless rows, and counts", () => {
    const items = [
      item({ id: "a" }),
      item({ id: "b", name: "Home-made stove", unitWeightMg: 40_000 }),
      item({ id: "c", catalogItemId: 77, catalogWeightMgAtLink: 1 }),
      item({ id: "d", name: "   " }),
    ];
    const { items: out, matched } = linkImportedItems(items, [row(), null, row({ id: 5 }), row({ id: 6 })]);
    expect(matched).toBe(1);
    expect(out[0]!.catalogItemId).toBe(1);
    expect(out[1]!.catalogItemId).toBeUndefined();
    expect(out[2]!.catalogItemId).toBe(77);
    expect(out[3]!.catalogItemId).toBeUndefined();
  });
});
