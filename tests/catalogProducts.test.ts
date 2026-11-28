// A catalog product (the rows that share a brand and a model) and the version step's
// rules: which rows are one product, what order its versions read in, and how typed
// words narrow them. The last is pinned over the real catalog, because the claim the
// menu rests on is about every product in it: typing a version's own words reaches it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { csvToCatalogRows } from "../scripts/catalogCsv";
import { CATALOG_CSV } from "../scripts/paths";
import { beginsVersion, compareVersions, groupProducts, leftoverWords, narrowVersions, nearestVersion, productKey } from "../shared/catalogProducts";
import type { CatalogSearchResult } from "../shared/catalogSearch";

const row = (id: number, name: string, variant: string | null, brand = "El Coyote"): CatalogSearchResult => ({
  id,
  brand,
  name,
  variant,
  weightMg: 1000,
  weightSource: "manufacturer",
  verified: true,
});
const quilt = (id: number, variant: string) => row(id, "AlphaLite 900 Quilt", variant);

describe("productKey", () => {
  it("folds case and accents, and keeps the plus that tells two products apart", () => {
    expect(productKey("Zpacks", "Duplex")).toBe(productKey("ZPACKS", "duplex"));
    expect(productKey("Fjällräven", "Kånken")).toBe(productKey("Fjallraven", "Kanken"));
    expect(productKey("Altra", "Lone Peak 9")).not.toBe(productKey("Altra", "Lone Peak 9+"));
    expect(productKey(null, "Polycro")).toBe(productKey("", "Polycro"));
    // and the minus that tells a -15F bag from a 15F one, where other hyphens are spacing
    expect(productKey("Mountain Hardwear", "Bishop Pass Windstopper -15F")).not.toBe(productKey("Mountain Hardwear", "Bishop Pass Windstopper 15F"));
    expect(productKey("Durston", "X-Mid 2")).toBe(productKey("Durston", "X Mid 2"));
  });
});

describe("groupProducts", () => {
  it("gathers a product's rows where its first row stood, even when they arrive apart", () => {
    const rows = [quilt(1, "10F"), row(9, "AlphaLite Hood", null), quilt(2, "20F")];
    const products = groupProducts(rows);
    expect(products.map((p) => p.rows.map((r) => r.id))).toEqual([[1, 2], [9]]);
  });
});

describe("compareVersions", () => {
  it("reads numbers by value and puts the row with no version first", () => {
    const sorted = [quilt(1, "20F, Regular"), quilt(2, "10F, Regular Wide"), quilt(3, "10F, Regular"), quilt(4, "100F"), row(5, "AlphaLite 900 Quilt", null)]
      .sort(compareVersions)
      .map((r) => r.variant);
    expect(sorted).toEqual([null, "10F, Regular", "10F, Regular Wide", "20F, Regular", "100F"]);
  });
});

describe("narrowVersions", () => {
  const sizes = ["10F, Regular", "10F, Regular Wide", "20F, Regular", "20F, Regular Wide", "20F, Short", "20F, Tall Wide"].map((v, i) => quilt(i + 1, v));
  const left = (text: string) => narrowVersions(sizes, text).map((r) => r.variant);

  it("keeps the versions every typed word begins a word of", () => {
    expect(left("20")).toEqual(["20F, Regular", "20F, Regular Wide", "20F, Short", "20F, Tall Wide"]);
    expect(left("20 reg")).toEqual(["20F, Regular", "20F, Regular Wide"]);
    expect(left("20 reg w")).toEqual(["20F, Regular Wide"]);
    expect(left("WIDE")).toEqual(["10F, Regular Wide", "20F, Regular Wide", "20F, Tall Wide"]);
  });
  it("keeps the order given, and names the version the words most nearly say", () => {
    const bivy = ["5ft 6in", "6ft", "6ft 6in", "6ft 6in Wide", "6ft Wide"].map((v, i) => row(i + 1, "Bristlecone Bivy", v, "Katabatic Gear"));
    const fits = narrowVersions(bivy, "6ft wide");
    expect(fits.map((r) => r.variant)).toEqual(["6ft 6in Wide", "6ft Wide"]);
    expect(fits[nearestVersion(fits)]!.variant).toBe("6ft Wide");
    // among equals, the first
    expect(nearestVersion(narrowVersions(sizes, "20"))).toBe(0);
    expect(nearestVersion([])).toBe(-1);
  });
  it("reads Women's however it is typed", () => {
    const pair = [row(1, "Ghost Whisperer Hoody", "Men's Medium"), row(2, "Ghost Whisperer Hoody", "Women’s")];
    for (const typed of ["womens", "women's", "Women’s", "wom"]) expect(narrowVersions(pair, typed).map((r) => r.id)).toEqual([2]);
    expect(narrowVersions(pair, "mens m").map((r) => r.id)).toEqual([1]);
  });
  it("is every version with nothing typed, and none when the words fit nothing", () => {
    expect(left("  ")).toHaveLength(6);
    expect(left("long")).toEqual([]);
    // mid-word is not the start of a word
    expect(left("ular")).toEqual([]);
  });

  // The whole catalog: for every product sold in versions, typing a version's own words
  // leaves that version, and it is the one the menu lights among any that merely extend
  // it ("Regular" over "Regular Wide"). This is what lets rows, not a control per axis,
  // carry a product in sixteen sizes.
  it("reaches every version of every product by its own words", () => {
    const products = groupProducts(
      csvToCatalogRows(readFileSync(CATALOG_CSV, "utf8")).map((r, i) => ({ ...row(i + 1, r.name, r.variant, r.brand ?? ""), brand: r.brand })),
    ).filter((p) => p.rows.length > 1);
    expect(products.length).toBeGreaterThan(500);
    const missed: string[] = [];
    for (const p of products) {
      const versions = [...p.rows].sort(compareVersions);
      for (const v of versions) {
        if (!v.variant) continue; // the plain model has no words; it is the row shown with none typed
        const fits = narrowVersions(versions, v.variant);
        if (fits[nearestVersion(fits)] !== v) missed.push(`${v.brand} ${v.name} [${v.variant}]`);
      }
    }
    expect(missed).toEqual([]);
  });
});

describe("beginsVersion", () => {
  it("is true for a version being typed from its start", () => {
    expect(beginsVersion("wom", "Women's")).toBe(true);
    expect(beginsVersion("womens", "Women’s XS/S")).toBe(true);
    expect(beginsVersion("20 reg", "20F, Regular Wide")).toBe(true);
  });
  it("is false for words that fit a version without beginning it, and for nothing typed", () => {
    expect(beginsVersion("large", "X-Large")).toBe(false);
    expect(beginsVersion("medium", "Men's Medium")).toBe(false);
    expect(beginsVersion("20 reg w", "20F, Regular")).toBe(false);
    expect(beginsVersion("", "Regular")).toBe(false);
    expect(beginsVersion("regular", null)).toBe(false);
  });
});

describe("leftoverWords", () => {
  const hoody = { brand: "Mountain Hardwear", name: "Ghost Whisperer Hoody" };
  it("keeps the words that name no part of the product", () => {
    expect(leftoverWords("ghost whisperer hoody women", hoody)).toBe("women");
    expect(leftoverWords("alphalite 20 reg", { brand: "El Coyote", name: "AlphaLite 900 Quilt" })).toBe("20 reg");
    expect(leftoverWords("ghost whisperer hoody women's", hoody)).toBe("womens");
    expect(leftoverWords("pa'lante shorts hemp", { brand: "Pa'lante", name: "Shorts" })).toBe("hemp");
  });
  it("leaves nothing when the name is all that was typed, in part or in full", () => {
    expect(leftoverWords("ghost whisp", hoody)).toBe("");
    expect(leftoverWords("Mountain Hardwear Ghost Whisperer Hoody", hoody)).toBe("");
    // a number in the model is the model's
    expect(leftoverWords("alphalite 900", { brand: "El Coyote", name: "AlphaLite 900 Quilt" })).toBe("");
  });
});
