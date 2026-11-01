// The rules the seed uses to find the live row a retired catalog row now means
// (shared/catalogLinks.ts). Every case below is a real pair from the September 2026
// catalog tidy, where a deleted row stranded the lists and My Gear rows that held it.
import { describe, expect, it } from "vitest";
import { matchSuccessor, sameProduct, sameSpelling, type LinkCandidate } from "../shared/catalogLinks";

let nextId = 1;
const row = (brand: string | null, name: string, variant: string | null, grams: number): LinkCandidate => ({
  id: nextId++,
  brand,
  name,
  variant,
  weightMg: grams * 1000,
});

describe("sameSpelling", () => {
  it.each([
    [{ brand: "Senchi Designs", name: "Alpha 60 Hoodie", variant: "Men’s M" }, { brand: "Senchi Designs", name: "Alpha 60 Hoodie", variant: "Men's Medium" }],
    [{ brand: "Black Diamond", name: "Distance 22", variant: "M" }, { brand: "Black Diamond", name: "Distance 22", variant: "Medium" }],
    [{ brand: "Zenbivy", name: "Fast Sheet", variant: '20"' }, { brand: "Zenbivy", name: "Fast Sheet", variant: "20in" }],
    [{ brand: "Leki", name: "Skysolo FX Carbon Trekking Poles", variant: "120-140 cm, per pair" }, { brand: "Leki", name: "Skysolo FX Carbon Trekking Poles", variant: "120-140cm, per pair" }],
    [{ brand: "Sun Bum", name: "Sunscreen Lip Balm SPF 30", variant: "0.15 oz" }, { brand: "Sun Bum", name: "Sunscreen Lip Balm SPF 30", variant: "0.15oz" }],
    [{ brand: "Teva", name: "Original Universal Sandals", variant: "size 11" }, { brand: "Teva", name: "Original Universal Sandals", variant: "US 11" }],
    [{ brand: "Matador", name: "Refillable Toothpaste Tubes", variant: "1-week" }, { brand: "Matador", name: "Refillable Toothpaste Tube", variant: "1-week" }],
    [{ brand: "Big Agnes", name: "Rapide SL Pillow", variant: "One size" }, { brand: "Big Agnes", name: "Rapide SL Pillow", variant: null }],
    // the variant moved out of the name, and the brand was said twice
    [{ brand: "Durston", name: "Durston Kakwa 55 UltraGrid / M", variant: null }, { brand: "Durston", name: "Kakwa 55", variant: "UltraGrid, Medium" }],
    [{ brand: "PETZL", name: "Petzl Cordex Plus belay/rappel gloves Size L", variant: null }, { brand: "Petzl", name: "Cordex Plus belay/rappel gloves", variant: "Large" }],
    [{ brand: "CNOC", name: "Vecto Water Container (28mm)", variant: "2L" }, { brand: "CNOC", name: "Vecto Water Container", variant: "2L, 28mm" }],
  ])("%o is %o", (a, b) => {
    expect(sameSpelling(a, b)).toBe(true);
  });

  it.each([
    [{ name: "Lone Peak 9+", brand: "Altra" }, { name: "Lone Peak 9", brand: "Altra" }],
    [{ name: "Kakwa 55", brand: "Durston", variant: "Ultra 200X, Medium" }, { name: "Kakwa 55", brand: "Durston", variant: "UltraGrid, Medium" }],
    [{ name: "Alpha 60 Hoodie", brand: "Senchi Designs", variant: "Men's L" }, { name: "Alpha 60 Hoodie", brand: "Senchi Designs", variant: "Men's Medium" }],
    [{ name: "Z Lite Original", brand: "Therm-a-Rest", variant: "Regular" }, { name: "Z Lite Sol", brand: "Therm-a-Rest", variant: "Regular" }],
  ])("%o is not %o", (a, b) => {
    expect(sameSpelling(a, b)).toBe(false);
  });

  it("reads product and variant apart", () => {
    expect(sameProduct({ brand: "Goldwin", name: "GORE-TEX 3L Jacket", variant: "size 3, M" }, { brand: "Goldwin", name: "GORE-TEX 3L Jacket", variant: "JP 3" })).toBe(true);
  });
});

describe("matchSuccessor", () => {
  it("takes the one live row that spells the same thing", () => {
    const medium = row("Senchi Designs", "Alpha 60 Hoodie", "Men's Medium", 107.7);
    expect(matchSuccessor({ brand: "Senchi Designs", name: "Alpha 60 Hoodie", variant: "Men's M" }, [medium])).toEqual({ row: medium, by: "spelling" });
  });

  it("refuses when two live rows spell it", () => {
    const a = row("Teva", "Original Universal Sandals", "US 11", 411.1);
    const b = row("Teva", "Original Universal Sandals", "Size 11", 411.1);
    expect(matchSuccessor({ brand: "Teva", name: "Original Universal Sandals", variant: "size 11" }, [a, b])).toBeNull();
  });

  it("follows a fold: two variants that distinguished nothing became the product's one row", () => {
    const bar = row("Clif", "Builders Protein Bar (Chocolate Peanut Butter)", null, 68);
    const other = row("Clif", "Energy Bar (Crunchy Peanut Butter)", null, 68);
    for (const variant of ["single bar", "per bar"]) {
      expect(matchSuccessor({ brand: "Clif", name: "Builders Protein Bar (Chocolate Peanut Butter)", variant, weightMg: 68_000 }, [bar, other])).toEqual({ row: bar, by: "variantless" });
    }
  });

  it("accepts a re-axed variant at the same weight, and nothing at a different one", () => {
    const jacket = row("Goldwin", "GORE-TEX 3L Jacket", "JP 3", 420);
    expect(matchSuccessor({ brand: "Goldwin", name: "GORE-TEX 3L Jacket", variant: "size 3, M", weightMg: 420_000 }, [jacket])).toEqual({ row: jacket, by: "weight" });
    // a size the catalog dropped is not the size it kept
    expect(matchSuccessor({ brand: "Goldwin", name: "GORE-TEX 3L Jacket", variant: "size 4, L", weightMg: 455_000 }, [jacket])).toBeNull();
  });

  it("lets the weight pick one row out of several, or none", () => {
    const s = row("Zenbivy", "Compression Cap", "10L", 70);
    const m = row("Zenbivy", "Compression Cap", "15L", 76);
    expect(matchSuccessor({ brand: "Zenbivy", name: "Compression Cap", variant: "Fifteen", weightMg: 76_000 }, [s, m])).toEqual({ row: m, by: "weight" });
    expect(matchSuccessor({ brand: "Zenbivy", name: "Compression Cap", variant: "Seven", weightMg: 65_000 }, [s, m])).toBeNull();
  });

  it("finds nothing for another product", () => {
    expect(matchSuccessor({ brand: null, name: "Deodorant" }, [row("CORPUS", "Nº Green Natural Deodorant Stick", "75g", 75)])).toBeNull();
  });
});
