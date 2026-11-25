// The catalog's formatting conventions, each pinned by a synthetic row that breaks
// it. tests/catalog-data.test.ts proves the REAL catalog passes; this file proves
// each rule still fires, so a check can't be quietly loosened into a no-op.

import { describe, expect, it } from "vitest";
import { buildCatalog } from "../scripts/catalogBuild";
import type { CatalogCsvRow } from "../scripts/catalogCsv";
import { runCatalogChecks } from "../scripts/catalogChecks";
import type { ResearchFile } from "../scripts/research";
import { kcalMatchesQuote, runResearchChecks, servingsOf } from "../scripts/researchChecks";
import { tidyQuote } from "../shared/catalogQuality";

const row = (o: Partial<CatalogCsvRow> & { name: string }): CatalogCsvRow => ({
  brand: "Acme",
  commonName: "Tent",
  variant: null,
  attributes: null,
  attributesUnpublished: [],
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
    // one fact in two scales is two claims too: the length as the maker's word and as a height
    const ff = row({ name: "Egret", variant: "Regular, 5ft 3in, 20F", categoryHint: "sleep", weightMg: 700_000, commonName: "Sleeping bag", attributes: { length: "Regular", temp_f: 20 } });
    expect(codes([ff], "error")).toContain("attr-conflict");
    expect(codes([{ ...ff, variant: "20F, Regular" }], "error")).toEqual([]);
    const goldwin = row({ brand: "Goldwin", name: "GORE-TEX 3L Jacket", variant: "Medium, JP 3", categoryHint: "clothing", weightMg: 420_000, commonName: "Rain jacket", attributes: { size: "M" } });
    expect(codes([goldwin], "error")).toContain("attr-conflict");
    expect(codes([{ ...goldwin, variant: "JP 3", attributes: { size: "JP 3" } }], "error")).toEqual([]);
  });

  it("attr-gap: a row without an axis its gear type is sold by is a warning, a to-do", () => {
    const pad = row({ name: "XLite", categoryHint: "sleep", weightMg: 370_000, commonName: "Sleeping pad" });
    expect(codes([pad], "warning")).toContain("attr-gap");
    expect(codes([{ ...pad, attributes: { r_value: 4.5, length: "Regular" } }], "warning")).not.toContain("attr-gap");
    // an axis the maker was found not to publish is researched, not a gap
    expect(codes([{ ...pad, attributes: { length: "Regular" }, attributesUnpublished: ["r_value"] }], "warning")).not.toContain("attr-gap");
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

  it("name-gender: Men's / Women's is the fit, read out of the variant", () => {
    const jacket = (name: string, variant: string) =>
      row({ brand: "Katabatic Gear", name, variant, categoryHint: "clothing", weightMg: 300_000, commonName: "Down jacket", attributes: { fit: "Women's", size: "M" } });
    expect(codes([jacket("Women's Tarn Down Jacket", "Medium")], "error")).toContain("name-gender");
    expect(codes([jacket("The Aspen Women's Backpack", "Medium")], "error")).toContain("name-gender");
    expect(codes([jacket("Tarn Down Jacket", "Women's Medium")], "error")).not.toContain("name-gender");
    // a possessive that isn't a gender is a name
    expect(codes([row({ brand: "Mountain Hardwear", name: "Hardwear Mountain Livin' Cap", categoryHint: "clothing", weightMg: 60_000, commonName: "Hat" })], "error")).not.toContain("name-gender");
  });

  it("name-unit-mark: the variant's unit rule holds in the name", () => {
    const shorts = (name: string) => row({ brand: "Satisfy", name, variant: "Medium", categoryHint: "clothing", weightMg: 90_000, commonName: "Shorts", attributes: { size: "M" } });
    expect(codes([shorts('TechSilk 8" Shorts')], "error")).toContain("name-unit-mark");
    expect(codes([shorts("TechSilk 8in Shorts")], "error")).not.toContain("name-unit-mark");
    expect(codes([row({ name: "Flat Tarp 7' x 9'", commonName: "Tarp", weightMg: 133_000 })], "error")).toContain("name-unit-mark");
    expect(codes([row({ name: "Flex 15°F Quilt", variant: "Regular", categoryHint: "sleep", commonName: "Quilt", weightMg: 723_000, attributes: { length: "Regular" } })], "error")).toContain("name-unit-mark");
    expect(codes([row({ name: "G-Hook Buckle ⅝", categoryHint: "other", commonName: "Buckle", weightMg: 3_000 })], "error")).toContain("name-unit-mark");
    // an apostrophe in a word is not a foot mark
    expect(codes([row({ brand: "Ortovox", name: "185 Rock'N'Wool Boxer", variant: "Men's", categoryHint: "clothing", commonName: "Underwear", weightMg: 60_000, attributes: { fit: "Men's" } })], "error")).not.toContain("name-unit-mark");
  });

  it("variant-redundant: no part of the variant repeats the name, and a bag's rating is said once", () => {
    const pack = (variant: string) => row({ brand: "Liteway", name: "Elementum Pack Ultra", variant, categoryHint: "pack", weightMg: 565_000, commonName: "Backpack", attributes: { volume_l: 50 } });
    expect(codes([pack("Ultra, 50L")], "error")).toContain("variant-redundant");
    expect(codes([pack("50L")], "error")).not.toContain("variant-redundant");
    const bag = (name: string, variant: string) =>
      row({ brand: "Feathered Friends", name, variant, categoryHint: "sleep", weightMg: 723_000, commonName: "Sleeping bag", attributes: { length: "Regular", temp_f: 20 } });
    expect(codes([bag("Egret UL 20", "20F, Regular")], "error")).toContain("variant-redundant");
    expect(codes([bag("Spark 20F", "20F, Regular")], "error")).toContain("variant-redundant");
    expect(codes([bag("Egret UL 20", "Regular")], "error")).not.toContain("variant-redundant");
    // a bag whose name carries no rating states it in the variant
    expect(codes([bag("UltraLite", "20F, Regular")], "error")).not.toContain("variant-redundant");
    // a number in the name that isn't this rating
    expect(codes([bag("Egret UL 30", "20F, Regular")], "error")).not.toContain("variant-redundant");
  });

  it("variant-axis-order: gender, rating, fill power, length or size, then the rest", () => {
    const quilt = (variant: string) => row({ name: "Revelation", variant, categoryHint: "sleep", weightMg: 560_000, commonName: "Quilt", attributes: { temp_f: 20, fill_power: 850, length: "Regular" } });
    expect(codes([quilt("Regular, 20F, 850FP")], "error")).toContain("variant-axis-order");
    expect(codes([quilt("20F, Regular, 850FP")], "error")).toContain("variant-axis-order");
    expect(codes([quilt("20F, 850FP, Regular")], "error")).not.toContain("variant-axis-order");
    const bag = (variant: string) => row({ name: "Magma 30", variant, categoryHint: "sleep", weightMg: 640_000, commonName: "Sleeping bag", attributes: { fit: "Women's", length: "Regular" } });
    expect(codes([bag("Regular, Women's")], "error")).toContain("variant-axis-order");
    expect(codes([bag("Women's, Regular")], "error")).not.toContain("variant-axis-order");
    // a length in feet is a length; the rest (a fabric, a footbox) follows freely
    expect(codes([row({ name: "UltraLite", variant: "6ft, 20F", categoryHint: "sleep", weightMg: 820_000, commonName: "Sleeping bag", attributes: { length: "6ft", temp_f: 20 } })], "error")).toContain("variant-axis-order");
    expect(codes([quilt("20F, 850FP, Regular, insulated footbox")], "error")).not.toContain("variant-axis-order");
  });

  it("category-outlier: one gear type, one category", () => {
    const sunscreen = (brand: string, categoryHint: string) => row({ brand, name: "Sun Stick", categoryHint, weightMg: 20_000, commonName: "Sunscreen" });
    expect(codes([sunscreen("Bioré", "other"), sunscreen("Anessa", "consumable"), sunscreen("Tocobo", "consumable")], "error")).toContain("category-outlier");
    expect(codes([sunscreen("Bioré", "consumable"), sunscreen("Anessa", "consumable")], "error")).not.toContain("category-outlier");
    // a tie names both rows: someone has to decide
    expect(codes([sunscreen("Bioré", "other"), sunscreen("Anessa", "consumable")], "error").filter((c) => c === "category-outlier")).toHaveLength(2);
  });

  it("category-outlier: rows with no gear type aren't one gear type, and common-name-missing already names them", () => {
    const untyped = (brand: string, categoryHint: string, commonName: string | null = null) => row({ brand, name: "Thing", categoryHint, weightMg: 20_000, commonName });
    const found = codes([untyped("Acme", "other"), untyped("Bolt", "cook"), untyped("Core", "cook", "  ")], "error");
    expect(found.filter((c) => c === "common-name-missing")).toHaveLength(3);
    expect(found).not.toContain("category-outlier");
  });

  it("variant-unit-spacing: one token, plainly written, no unit marks", () => {
    const v = (variant: string) => codes([row({ name: "Flash", variant, categoryHint: "cook", weightMg: 371_000, commonName: "Stove system" })], "error");
    for (const bad of ["6 ft", '17" torso', "1.0L", "6ft 0in", "20 x 72", "Titanium ⅝in", "20°F"]) expect(v(bad)).toContain("variant-unit-spacing");
    for (const ok of ["6ft", "1L", "6ft 6in", "20x72", "5ft x 8ft", "Titanium 5/8in", "0.5 DCF", "Women's Medium"]) expect(v(ok)).not.toContain("variant-unit-spacing");
  });

  it("name-size-prefix and name-plural-family: one singular name per family", () => {
    expect(codes([row({ name: "Large Food Bag", categoryHint: "other", weightMg: 38_000, commonName: "Food bag" })], "error")).toContain("name-size-prefix");
    expect(codes([row({ name: "Stuff Sacks", variant: "M", categoryHint: "other", weightMg: 8_000, commonName: "Stuff sack" })], "error")).toContain("name-plural-family");
    // inherent plurals are fine
    expect(codes([row({ name: "Hiker Midweight Socks", variant: "Men's Large", categoryHint: "clothing", weightMg: 70_000, commonName: "Socks" })], "error")).not.toContain("name-plural-family");
  });

  it("variant-size-style: words, not letters (2026-09-12), and the words spelled the house way", () => {
    expect(codes([row({ name: "Kakwa 55", variant: "M", categoryHint: "pack", weightMg: 900_000, commonName: "Backpack" })], "error")).toContain("variant-size-style");
    expect(codes([row({ name: "Cormac Hoody", variant: "Men's L", categoryHint: "clothing", weightMg: 200_000, commonName: "Sun hoodie" })], "error")).toContain("variant-size-style");
    expect(codes([row({ name: "Cormac Hoody", variant: "Extra small", categoryHint: "clothing", weightMg: 200_000, commonName: "Sun hoodie" })], "error")).toContain("variant-size-style");
    expect(codes([row({ name: "Kakwa 55", variant: "Medium", categoryHint: "pack", weightMg: 900_000, commonName: "Backpack" })], "error")).not.toContain("variant-size-style");
    expect(codes([row({ name: "Cormac Hoody", variant: "Men's Medium", categoryHint: "clothing", weightMg: 200_000, commonName: "Sun hoodie" })], "error")).not.toContain("variant-size-style");
    // a range keeps the maker's letters
    expect(codes([row({ name: "Kakwa 55", variant: "S/M", categoryHint: "pack", weightMg: 900_000, commonName: "Backpack" })], "error")).not.toContain("variant-size-style");
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

  it("colour-variant names the colour word, not the whole variant; variant-edition keeps an edition out of the variant", () => {
    const cap = (variant: string) => row({ brand: "Norda", name: "Luster Cap", variant, categoryHint: "clothing", weightMg: 36_000, commonName: "Hat" });
    const colour = runCatalogChecks([cap("Trail Team Edition, Stone")]).filter((f) => f.code === "colour-variant");
    expect(colour).toHaveLength(1);
    // the chat read the whole variant quoted back as all of it refused
    expect(colour[0]!.message).toContain('"Stone" in variant');
    // every colour at once, so a two-colour variant isn't refused twice over
    expect(runCatalogChecks([cap("Black/Red, Large")]).find((f) => f.code === "colour-variant")!.message).toContain('"Black", "Red" in variant');
    expect(codes([cap("Trail Team Edition")], "error")).toEqual(["variant-edition"]);
    expect(codes([cap("Special Editions")], "error")).toContain("variant-edition");
    // an edition sold as its own build is a product, named in the name, as the research has them
    expect(codes([row({ brand: "Amazon", name: "Kindle Paperwhite Signature Edition", variant: "2024", categoryHint: "electronics", weightMg: 214_000, commonName: "E-reader" })], "error")).not.toContain("variant-edition");
  });

  it("footwear-size and per-pair-label", () => {
    expect(codes([row({ name: "Lone Peak 9", variant: "Men's 9", categoryHint: "clothing", weightMg: 600_000, commonName: "Trail runners" })], "error")).toContain("footwear-size");
    expect(codes([row({ name: "Merino Sock", variant: "M, per pair", categoryHint: "clothing", weightMg: 60_000, commonName: "Socks" })], "error")).toContain("per-pair-label");
  });

  it("kcal-on-non-food: a canister's energy content is not a ration", () => {
    const can = row({ name: "IsoPro Fuel Canister", variant: "110g, net fuel", categoryHint: "consumable", weightMg: 110_000, commonName: "Fuel canister", attributes: { fuel_g: 110 } });
    expect(codes([can], "error")).not.toContain("kcal-on-non-food");
    expect(codes([{ ...can, kcal: 1350 }], "error")).toContain("kcal-on-non-food");
    // a stove, with or without a fuel axis, is not food either
    expect(codes([row({ name: "PocketRocket 2", categoryHint: "cook", weightMg: 73_000, commonName: "Stove", kcal: 100, attributes: { fuel: "isobutane" } })], "error")).toContain("kcal-on-non-food");
    // food keeps its kcal
    expect(codes([row({ name: "Pad Thai", variant: "2 servings", categoryHint: "consumable", weightMg: 176_000, kcal: 760, commonName: "Meal" })], "error")).not.toContain("kcal-on-non-food");
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
  it("attr-unpublished: a real axis, and never one the row also states", () => {
    const withUnpub = (attributes: unknown, unpublished: unknown) => {
      const f = file(attributes);
      (f.rows[0] as Record<string, unknown>).attributes_unpublished = unpublished;
      return runResearchChecks([f]).filter((x) => x.level === "error").map((x) => x.code);
    };
    expect(withUnpub(undefined, ["r_value"])).toEqual([]);
    expect(withUnpub(undefined, ["colour"])).toContain("attr-unpublished");
    expect(withUnpub(undefined, [])).toContain("attr-unpublished");
    expect(withUnpub({ persons: 2 }, ["persons"])).toContain("attr-unpublished");
  });
});

describe("research-level weight conversion", () => {
  const withUnit = (weight_unit: string): ResearchFile => ({
    file: "synthetic.json",
    rows: [{ brand: "Acme", name: "Ridge 2", variant: "2P", common_name: "tent", category_hint: "shelter", weight_value: 900, weight_unit, weight_source: "manufacturer", source_url: "https://acme.example/ridge", quote: "900 g" }],
  });
  const errors = (f: ResearchFile) => runResearchChecks([f]).filter((x) => x.level === "error").map((x) => x.code);
  const skipped = (f: ResearchFile) => buildCatalog([f], new Map()).skipped;
  it("reads the unit as the build does: a row that builds isn't refused for convert", () => {
    for (const unit of ["g", " g", "g\n"]) {
      expect(skipped(withUnit(unit))).toEqual([]);
      expect(errors(withUnit(unit))).toEqual([]);
    }
    // and a unit the build can't read is refused by both
    expect(skipped(withUnit("grams"))).toHaveLength(1);
    expect(errors(withUnit("grams"))).toContain("convert");
  });
});

describe("research-level quote hygiene", () => {
  const withQuote = (quote: string): ResearchFile => ({
    file: "synthetic.json",
    rows: [{ brand: "Acme", name: "Echo Hoodie", variant: "Men's Medium", common_name: "rain jacket", category_hint: "clothing", weight_value: 150, weight_unit: "g", weight_source: "manufacturer", source_url: "https://acme.example/echo", quote }],
  });
  const codes = (f: ResearchFile) => runResearchChecks([f]).filter((x) => x.level === "error").map((x) => x.code);
  it("a quote is one line of the page's words, single spaces, no markup", () => {
    expect(codes(withQuote("Weight: 5.29 oz/ 150 g"))).toEqual([]);
    expect(codes(withQuote('<div class="specs-title">Weight:</div> 5.29 oz/ 150 g'))).toContain("quote-hygiene");
    expect(codes(withQuote("Weight: 5.29 oz &amp; 150 g"))).toContain("quote-hygiene");
    expect(codes(withQuote("Weight:  5.29 oz | 150 g"))).toContain("quote-hygiene");
    expect(codes(withQuote("Weight: 5.29 oz | 150 g"))).toContain("quote-hygiene");
    expect(codes(withQuote("Sold as a 4-pack\nWeight: 150 g"))).toContain("quote-hygiene");
  });
  it("tidyQuote changes spacing only, never the words", () => {
    expect(tidyQuote(" Weight:  0.31oz |​ 9g\n")).toBe("Weight: 0.31oz | 9g");
    expect(tidyQuote("Weight: 5.29 oz/ 150 g")).toBe("Weight: 5.29 oz/ 150 g");
  });
});

describe("research-level tent weight basis", () => {
  const tent = (variant: string, weight_value: number, quote: string): ResearchFile => ({
    file: "synthetic.json",
    rows: [{ brand: "Acme", name: "Ridge 2", variant, common_name: "tent", category_hint: "shelter", weight_value, weight_unit: "g", weight_source: "manufacturer", source_url: "https://acme.example/ridge", quote }],
  });
  const codes = (f: ResearchFile, level: "error" | "warning") => runResearchChecks([f]).filter((x) => x.level === level).map((x) => x.code);
  it("a tent stored at the trail figure when the page also gives the packaged one is an error", () => {
    expect(codes(tent("2P", 1190, "Trail Weight: 1.19kg / 2lb 10oz. Packed Weight: 1.33kg / 2lb 15oz"), "error")).toContain("tent-weight-basis");
    expect(codes(tent("2P", 1330, "Trail Weight: 1.19kg / 2lb 10oz. Packed Weight: 1.33kg / 2lb 15oz"), "error")).toEqual([]);
  });
  it("a tent stored at a trail-only figure must say so, and saying so is a to-do", () => {
    expect(codes(tent("2P", 1340, "Minimum Weight: 1340g"), "error")).toContain("tent-weight-basis");
    expect(codes(tent("2P, trail weight", 1340, "Minimum Weight: 1340g"), "error")).toEqual([]);
    expect(codes(tent("2P, trail weight", 1340, "Minimum Weight: 1340g"), "warning")).toContain("tent-trail-weight");
    // "trail weight" while the page shows a packaged figure: store that instead
    expect(codes(tent("2P, trail weight", 1190, "Minimum Weight: 1190 g. Packed Weight: 1330 g"), "error")).toContain("tent-weight-basis");
  });
  it("a retailer's label after the figure counts too", () => {
    expect(codes(tent("1.5P", 539, "Weight: 19oz | 539g (trail)"), "error")).toContain("tent-weight-basis");
    expect(codes(tent("", 688, "Weight: 24oz | 688g (minimum)"), "error")).toContain("tent-weight-basis");
    expect(codes(tent("1.5P, trail weight", 539, "Weight: 19oz | 539g (trail)"), "error")).toEqual([]);
  });
  it("a tent quoted at one unlabelled figure raises nothing", () => {
    expect(codes(tent("2P", 509, "Tent: 17.9 oz / 509 g (Dyneema floor)"), "error")).toEqual([]);
  });
});

describe("research-level pack weight basis", () => {
  const pack = (variant: string, weight_value: number, quote: string, common_name = "backpack"): ResearchFile => ({
    file: "synthetic.json",
    rows: [{ brand: "Acme", name: "Ridge 40", variant, common_name, category_hint: "pack", weight_value, weight_unit: "g", weight_source: "manufacturer", source_url: "https://acme.example/ridge-40", quote }],
  });
  const codes = (f: ResearchFile, level: "error" | "warning") => runResearchChecks([f]).filter((x) => x.level === level).map((x) => x.code);
  it("a pack stored at its minimum when the page gives the full figure is an error, either order of label and figure", () => {
    expect(codes(pack("", 780, "WEIGHT: 780g (Minimum Weight), 1,200g (Fully Equipped)"), "error")).toContain("pack-weight-basis");
    expect(codes(pack("", 1200, "WEIGHT: 780g (Minimum Weight), 1,200g (Fully Equipped)"), "error")).toEqual([]);
    expect(codes(pack("", 1390, "3lb 7oz (1560g) with hip belt, 3lb 1oz (1390g) without hip belt"), "error")).toContain("pack-weight-basis");
    expect(codes(pack("with hipbelt", 1560, "3lb 7oz (1560g) with hip belt, 3lb 1oz (1390g) without hip belt"), "error")).toEqual([]);
    // a label naming the figure after it, inside a sentence that names the full one first
    expect(codes(pack("", 571, "weighs in at 1.26 lbs (stripped weight: 1.16 lb)"), "error")).toEqual([]);
  });
  it("a pack stored at a minimum-only figure must say so, and saying so is a to-do", () => {
    expect(codes(pack("", 295, "Weight: 10.4oz | 295g (minimum)"), "error")).toContain("pack-weight-basis");
    expect(codes(pack("minimum", 295, "Weight: 10.4oz | 295g (minimum)"), "error")).toEqual([]);
    expect(codes(pack("minimum", 295, "Weight: 10.4oz | 295g (minimum)"), "warning")).toContain("pack-minimum-weight");
    // "minimum" while the page shows the full pack: store that instead
    expect(codes(pack("minimum", 780, "WEIGHT: 780g (Minimum Weight), 1,200g (Fully Equipped)"), "error")).toContain("pack-weight-basis");
  });
  it("a pack whose belt is optional says no hipbelt, and that is no to-do", () => {
    expect(codes(pack("", 281, "Weight 9.9 oz / 281 g (30L, Standard Straps, No Belt)"), "error")).toContain("pack-weight-basis");
    expect(codes(pack("30L, no hipbelt", 281, "Weight 9.9 oz / 281 g (30L, Standard Straps, No Belt)"), "error")).toEqual([]);
    expect(codes(pack("30L, no hipbelt", 281, "Weight 9.9 oz / 281 g (30L, Standard Straps, No Belt)"), "warning")).not.toContain("pack-minimum-weight");
  });
  it("leaves unlabelled figures, and packs without a belt to speak of, alone", () => {
    expect(codes(pack("", 905, "Total with M Straight belt 31.9 oz / 905 g"), "error")).toEqual([]);
    expect(codes(pack("", 120, "Minimum weight: 120 g", "running vest"), "error")).toEqual([]);
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
