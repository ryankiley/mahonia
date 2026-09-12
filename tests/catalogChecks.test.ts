// The catalog's formatting conventions, each pinned by a synthetic row that breaks
// it. tests/catalog-data.test.ts proves the REAL catalog passes; this file proves
// each rule still fires, so a check can't be quietly loosened into a no-op.

import { describe, expect, it } from "vitest";
import type { CatalogCsvRow } from "../scripts/catalogCsv";
import { runCatalogChecks } from "../scripts/catalogChecks";
import type { ResearchFile } from "../scripts/research";
import { kcalMatchesQuote, runResearchChecks, servingsOf } from "../scripts/researchChecks";

const row = (o: Partial<CatalogCsvRow> & { name: string }): CatalogCsvRow => ({
  brand: "Acme",
  commonName: "Tent",
  variant: null,
  attributes: null,
  categoryHint: "shelter",
  weightMg: 1_000_000,
  kcal: null,
  weightSource: "manufacturer",
  sourceUrl: "https://acme.example/tent",
  searchTerms: null,
  ...o,
});

const codes = (rows: CatalogCsvRow[], level: "error" | "warning") =>
  runCatalogChecks(rows).filter((f) => f.level === level).map((f) => f.code);

describe("catalog conventions are errors, not warnings", () => {
  it("a clean row raises nothing", () => {
    expect(runCatalogChecks([row({ name: "Ridge 2", variant: "2P", attributes: { persons: 2 } })])).toEqual([]);
  });

  it("attr-missing / attr-mismatch: an axis the variant states is typed beside it, and agrees", () => {
    const quilt = (attributes: CatalogCsvRow["attributes"]) =>
      row({ name: "Revelation", variant: "20F, 950FP, Regular", categoryHint: "sleep", weightMg: 560_000, commonName: "Quilt", attributes });
    expect(codes([quilt(null)], "error")).toContain("attr-missing");
    expect(codes([quilt({ temp_f: 30, fill_power: 950, length: "Regular" })], "error")).toContain("attr-mismatch");
    expect(codes([quilt({ temp_f: 20, fill_power: 950, length: "Regular" })], "error")).toEqual([]);
    // an attribute the variant doesn't state is research, not a mismatch
    expect(codes([quilt({ temp_f: 20, fill_power: 950, length: "Regular", width: "Wide" })], "error")).toEqual([]);
  });

  it("attr-conflict: a variant that claims one axis twice", () => {
    const q = row({ name: "Burrow", variant: "Regular, Long", categoryHint: "sleep", weightMg: 600_000, commonName: "Quilt", attributes: { length: "Regular" } });
    expect(codes([q], "error")).toContain("attr-conflict");
    // a fact restated in another spelling is not a conflict
    const ff = row({ name: "Egret", variant: "Regular, 5ft 3in, 20F", categoryHint: "sleep", weightMg: 700_000, commonName: "Sleeping bag", attributes: { length: "Regular", temp_f: 20 } });
    expect(codes([ff], "error")).toEqual([]);
  });

  it("attr-gap: a row without an axis its gear type is sold by is a warning, a to-do", () => {
    const pad = row({ name: "XLite", categoryHint: "sleep", weightMg: 370_000, commonName: "Sleeping pad" });
    expect(codes([pad], "warning")).toContain("attr-gap");
    expect(codes([{ ...pad, attributes: { r_value: 4.5, length: "Regular" } }], "warning")).not.toContain("attr-gap");
    // every footwear type, booties included, is sold by a size
    expect(codes([row({ name: "Down Booties", categoryHint: "clothing", weightMg: 60_000, commonName: "Booties" })], "warning")).toContain("attr-gap");
    // a gear type sold one way has no gap to fill, and a laptop is not a top
    expect(codes([row({ name: "Cross Band", categoryHint: "other", weightMg: 5_000, commonName: "Rubber bands" })], "warning")).not.toContain("attr-gap");
    expect(codes([row({ name: "Air", categoryHint: "electronics", weightMg: 600_000, commonName: "Laptop" })], "warning")).not.toContain("attr-gap");
  });

  it("name-repeats-brand: the UI joins brand + name", () => {
    expect(codes([row({ brand: "Apple", name: "Apple Watch SE 3", categoryHint: "electronics", weightMg: 30_000, commonName: "Smartwatch" })], "error")).toContain("name-repeats-brand");
  });

  it("name-qualifier: a config hides in the name", () => {
    expect(codes([row({ name: "Quandary Pants - Regular", categoryHint: "clothing", weightMg: 300_000, commonName: "Hiking pants" })], "error")).toContain("name-qualifier");
    expect(codes([row({ name: "Moab 3 (low)", categoryHint: "clothing", weightMg: 900_000, commonName: "Hiking shoes" })], "error")).toContain("name-qualifier");
    // a food row's flavor is the one allowed parenthetical
    expect(codes([row({ name: "Energy Bar (Chocolate Chip)", categoryHint: "consumable", weightMg: 68_000, kcal: 250, commonName: "Energy bar" })], "error")).not.toContain("name-qualifier");
  });

  it("name-size-prefix and name-plural-family: one singular name per family", () => {
    expect(codes([row({ name: "Large Food Bag", categoryHint: "other", weightMg: 38_000, commonName: "Food bag" })], "error")).toContain("name-size-prefix");
    expect(codes([row({ name: "Stuff Sacks", variant: "M", categoryHint: "other", weightMg: 8_000, commonName: "Stuff sack" })], "error")).toContain("name-plural-family");
    // inherent plurals are fine
    expect(codes([row({ name: "Hiker Midweight Socks", variant: "Men's L", categoryHint: "clothing", weightMg: 70_000, commonName: "Socks" })], "error")).not.toContain("name-plural-family");
  });

  it("variant-size-style: letters, not words, on worn or carried gear", () => {
    expect(codes([row({ name: "Kakwa 55", variant: "Medium", categoryHint: "pack", weightMg: 900_000, commonName: "Backpack" })], "error")).toContain("variant-size-style");
    // sleep and shelter keep the maker's length words
    expect(codes([row({ name: "NeoAir XLite", variant: "Large", categoryHint: "sleep", weightMg: 400_000, commonName: "Sleeping pad" })], "error")).not.toContain("variant-size-style");
  });

  it("brand-case-split and variant-case-split: one spelling", () => {
    const rows = [
      row({ brand: "Flextail", name: "Zero Pump 2", categoryHint: "electronics", weightMg: 48_000, commonName: "Air pump" }),
      row({ brand: "FLEXTAIL", name: "Zero Power 5000", categoryHint: "electronics", weightMg: 85_000, commonName: "Power bank" }),
      row({ name: "Bear Canister", variant: "Standard", categoryHint: "other", weightMg: 900_000, commonName: "Bear canister" }),
      row({ name: "Bear Canister XL", variant: "standard", categoryHint: "other", weightMg: 1_100_000, commonName: "Bear canister" }),
    ];
    const e = codes(rows, "error");
    expect(e).toContain("brand-case-split");
    expect(e).toContain("variant-case-split");
  });

  it("variant-filler: One size, Unisex, 1 serving, Standard on a one-row product, a lonely unit label", () => {
    expect(codes([row({ name: "Radius Cap", variant: "One size", categoryHint: "clothing", weightMg: 40_000, commonName: "Hat" })], "error")).toContain("variant-filler");
    expect(codes([row({ name: "BV500", variant: "Standard", categoryHint: "other", weightMg: 1_160_000, commonName: "Bear canister" })], "error")).toContain("variant-filler");
    expect(codes([row({ name: "Energy Bar", variant: "per bar", categoryHint: "consumable", weightMg: 68_000, kcal: 250, commonName: "Energy bar" })], "error")).toContain("variant-filler");
    // a unit label beside a differently-counted sibling earns its place
    const tabs = [
      row({ brand: "Aquatabs", name: "Water Purification Tablets", variant: "per tablet", categoryHint: "water", weightMg: 200, commonName: "Water treatment" }),
      row({ brand: "Aquatabs", name: "Water Purification Tablets", variant: "sleeve of 10", categoryHint: "water", weightMg: 2_000, commonName: "Water treatment" }),
    ];
    expect(codes(tabs, "error")).not.toContain("variant-filler");
    // trekking poles keep "per pair"
    expect(codes([row({ name: "Distance Carbon Trekking Poles", variant: "per pair", categoryHint: "other", weightMg: 300_000, commonName: "Trekking poles" })], "error")).not.toContain("variant-filler");
  });

  it("footwear-size and per-pair-label", () => {
    expect(codes([row({ name: "Lone Peak 9", variant: "Men's 9", categoryHint: "clothing", weightMg: 600_000, commonName: "Trail runners" })], "error")).toContain("footwear-size");
    expect(codes([row({ name: "Merino Sock", variant: "M, per pair", categoryHint: "clothing", weightMg: 60_000, commonName: "Socks" })], "error")).toContain("per-pair-label");
  });

  it("food rows: net is a to-do, missing kcal is a to-do — both warnings, not errors", () => {
    const meal = row({ name: "Pad Thai", variant: "2 servings, net", categoryHint: "consumable", weightMg: 176_000, kcal: 760, commonName: "Meal" });
    expect(codes([meal], "warning")).toContain("food-net-weight");
    expect(codes([meal], "error")).not.toContain("variant-filler");
    const bar = row({ name: "Protein Bar", categoryHint: "consumable", weightMg: 52_000, commonName: "Protein bar" });
    expect(codes([bar], "warning")).toContain("food-kcal-missing");
  });
});

describe("research-level attributes check", () => {
  const file = (attributes: unknown): ResearchFile => ({
    file: "synthetic.json",
    rows: [{ brand: "Acme", name: "Ridge 2", variant: "2P", category_hint: "shelter", weight_value: 900, weight_unit: "g", weight_source: "manufacturer", source_url: "https://acme.example/ridge", quote: "900 g", attributes: attributes as never }],
  });
  const errs = (attributes: unknown) => runResearchChecks([file(attributes)]).filter((f) => f.level === "error").map((f) => f.code);
  it("attr: an unknown key, a wrong type or a non-canonical value on a research row is an error", () => {
    expect(errs({ temp: 20 })).toContain("attr");
    expect(errs({ persons: "2" })).toContain("attr");
    expect(errs({ length: "6 ft" })).toContain("attr");
    expect(errs({ persons: 2 })).toEqual([]);
    expect(errs(undefined)).toEqual([]);
  });
});

describe("research-level kcal cross-check", () => {
  it("reads servings from the variant or the quote", () => {
    expect(servingsOf("2 servings", "")).toBe(2);
    expect(servingsOf("", "Servings per container: 2 Single serving: 400 calories")).toBe(2);
    expect(servingsOf("", "Single serving : 410 calories — two servings in this pouch")).toBe(2);
    expect(servingsOf("", "Calories 200")).toBe(1);
  });
  it("accepts a per-pouch figure or a per-serving figure × servings, rejects anything else", () => {
    expect(kcalMatchesQuote(800, "Servings per container: 2 Single serving: 400 calories", 2)).toBe(true);
    expect(kcalMatchesQuote(200, "Serving Size 1 bar (52 g) … Calories 200", 1)).toBe(true);
    expect(kcalMatchesQuote(250, "Serving Size 1 bar (52 g) … Calories 200", 1)).toBe(false);
  });
});
