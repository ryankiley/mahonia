import { describe, expect, it } from "vitest";
import { emergingBrandTokens, isBrandedTypedItem, isVariantRedundant, normKey, normalizeVariant, quoteBacksWeight, splitKnownBrand, weightsInQuote } from "../shared/catalogQuality";

describe("normKey — a candidate's identity is the search fold", () => {
  it("keeps a name in any script, and folds an accent as the search does", () => {
    expect(normKey("Trekology 登山杖（裸杖）")).toBe("trekology 登山杖 裸杖");
    expect(normKey("Fjällräven Kajka")).toBe(normKey("Fjallraven Kajka"));
    expect(normKey("  Zpacks  Duplex! ")).toBe("zpacks duplex");
    expect(normKey(null)).toBe("");
  });
});

describe("normalizeVariant", () => {
  const cases: [string, string][] = [
    // orphan punctuation from an empty leading dimension
    ["/ M", "Medium"],
    [", 18F", "18F"],
    // fabric / size — slash is a dimension separator
    ["Ultra 200X / M", "Ultra 200X, Medium"],
    ["UltraGrid / M", "UltraGrid, Medium"],
    // temperature: drop degree symbol, no space, uppercase
    ["6 ft, 30°F", "6ft, 30F"],
    ["Regular / 20°F", "Regular, 20F"],
    // volume: no parens/space, uppercase L
    ["(9L)", "9L"],
    ["40 L", "40L"],
    ["L/XL (68 L)", "L/XL, 68L"],
    // trailing parenthetical qualifier unwraps into a dimension
    ["Regular (6 ft), 20°F", "Regular, 6ft, 20F"],
    ["Regular (tapered)", "Regular, tapered"],
    // KEEP genuine tokens
    ["S/M", "S/M"], // size range (unspaced)
    ["M/L torso", "M/L torso"], // size range + qualifier
    ["WXS/S (62 L)", "WXS/S, 62L"],
    ["32oz / 1L", "32oz / 1L"], // spaced unit equivalent
    ["20F / -6C, Regular, 650FP down", "20F / -6C, Regular, 650FP down"], // F/C temp equivalent
    ['Gridstop (16" / 19")', "Gridstop, 16in / 19in"], // measurement range kept, marks spelled out
    // "Size" prefix drops before an S/M/L size, and only there; the size is a word
    ["Size M", "Medium"],
    ["120gsm, Size M", "120gsm, Medium"],
    ["Size D", "Size D"],
    ["Size 9", "Size 9"],
    // a gender prefix and its size are one dimension
    ["Men's, M", "Men's Medium"],
    ["Women's, XS/S", "Women's XS/S"],
    // an S/M/L-family size is a word (2026-09-12); a range and a maker's own scale stay
    ["M", "Medium"],
    ["XS", "X-Small"],
    ["Men's M", "Men's Medium"],
    ["Women's XL", "Women's X-Large"],
    ["M torso", "Medium torso"],
    ["40L, M torso", "40L, Medium torso"],
    ["Regular torso, S hipbelt", "Regular torso, Small hipbelt"],
    ["M, Regular", "Medium, Regular"], // a size and an inseam
    ["M+", "M+"],
    ["L/XL", "L/XL"],
    ["Medium", "Medium"],
    ["27 L", "27L"], // a litre, not a Large
    ["M's 9, W's 10 US", "M's 9, W's 10 US"],
    // number + unit are one token; prime marks spell out
    ["6 ft, 20F", "6ft, 20F"],
    ["Regular, 5 ft 3 in, 20F", "Regular, 5ft 3in, 20F"],
    ["400 ml", "400ml"],
    ["1 m", "1m"],
    ["110-130 cm, per pair", "110-130cm, per pair"],
    ["solo, 9'", "solo, 9ft"],
    ['17" torso', "17in torso"],
    ["5' x 8.5'", "5ft x 8.5ft"],
    ["5'6\"", "5ft 6in"],
    ["8'6\" x 8'6\"", "8ft 6in x 8ft 6in"],
    ['Titanium ⅝"', "Titanium ⅝in"],
    ["Men's US 9", "Men's US 9"], // a size scale is not a unit
    ["Ultra 200X, M", "Ultra 200X, Medium"],
    // quantity phrasing
    ["3 Pack", "3-pack"],
    ["Set of 4, 55mm", "set of 4, 55mm"],
    ["Sleeve of 10", "sleeve of 10"],
    // "|" is a non-canonical separator (copied from a manufacturer quote) → comma
    ["M's 9 | W's 10 US", "M's 9, W's 10 US"],
    // already-canonical / no-op
    ["Men's Medium", "Men's Medium"],
    ["one size", "one size"],
    ["Long, 18F", "Long, 18F"],
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeVariant(input)).toBe(expected);
    });
  }

  it("is idempotent", () => {
    for (const [input] of cases) {
      const once = normalizeVariant(input);
      expect(normalizeVariant(once)).toBe(once);
    }
  });
});

describe("isVariantRedundant", () => {
  it("flags a variant whose tokens are already in the name", () => {
    expect(isVariantRedundant("Copper Spur HV UL3", "UL3")).toBe(true);
    expect(isVariantRedundant("Copper Spur HV UL2 mtnGLO", "UL2")).toBe(true); // contiguous, mid-name
    expect(isVariantRedundant("Trekking Umbrella 55", "55")).toBe(true);
    expect(isVariantRedundant("Amicus Stove with Igniter", "with igniter")).toBe(true);
  });
  it("keeps a variant that adds real info", () => {
    expect(isVariantRedundant("Kakwa 55", "UltraGrid, M")).toBe(false);
    expect(isVariantRedundant("Women's Tarn Down Jacket", "S")).toBe(false); // the "s" of a possessive is not a size
    expect(isVariantRedundant("Ether Light XT Insulated", "Regular")).toBe(false);
    expect(isVariantRedundant("Plex Solo", "")).toBe(false);
  });
});

describe("catalog-intake brands", () => {
  const spellings = new Map([
    ["katabatic gear", "Katabatic Gear"],
    ["ula equipment", "ULA Equipment"],
    ["big agnes", "Big Agnes"],
    ["big sky", "Big Sky"],
  ]);

  it("accepts and splits an unambiguous first word of a known multi-word brand", () => {
    const knownBrands = new Set(spellings.keys());
    expect(isBrandedTypedItem({ name: "Katabatic Alsek", knownBrands })).toBe(true);
    expect(splitKnownBrand("Katabatic Alsek", spellings)).toEqual({ brand: "Katabatic Gear", name: "Alsek" });
    expect(splitKnownBrand("ULA Circuit", spellings)).toEqual({ brand: "ULA Equipment", name: "Circuit" });
  });

  it("refuses ambiguous or generic brand shorthand", () => {
    const knownBrands = new Set(spellings.keys());
    expect(isBrandedTypedItem({ name: "Big Tent", knownBrands })).toBe(false);
    expect(splitKnownBrand("Big Tent", spellings)).toEqual({ brand: null, name: "Big Tent" });
  });

  it("only treats a new leading token as a brand after two corroborated product names", () => {
    const emerging = emergingBrandTokens([
      { normKey: "timmermade sul 15", name: "Timmermade SUL 1.5" },
      { normKey: "timmermade bilby", name: "Timmermade Bilby" },
      { normKey: "single maker", name: "Solitary Maker" },
    ]);
    expect(emerging).toEqual(new Set(["timmermade"]));
    expect(isBrandedTypedItem({ name: "Timmermade Alpha Cruiser", knownBrands: new Set(), emergingBrands: emerging })).toBe(true);
    expect(isBrandedTypedItem({ name: "Solitary Maker", knownBrands: new Set(), emergingBrands: emerging })).toBe(false);
    expect(splitKnownBrand("Timmermade Alpha Cruiser", new Map(), emerging))
      .toEqual({ brand: "Timmermade", name: "Alpha Cruiser" });
  });
});

describe("weightsInQuote — the figures verify_catalog_item holds a quote to", () => {
  const read = (q: string) => weightsInQuote(q).map(Math.round);
  it("reads grams, ounces, pounds, and a pound-and-ounce figure as one", () => {
    expect(read("Total Weight: 36 oz / 1022 g")).toEqual([1022, 1021]);
    expect(read("Weight: 1 lb 4 oz")).toEqual([567]);
    expect(read("1 lb, 3.5 oz")).toEqual([553]);
    expect(read("2.1 lbs")).toEqual([953]);
  });

  it("reads a figure with no leading digit whole", () => {
    // once read as "60 oz", 1.7 kg, which backed a weight the quote never stated
    expect(read("The Deuce #2 - .60 oz")).toEqual([17]);
    expect(quoteBacksWeight(".5 oz", 14)).toBe(true);
    expect(quoteBacksWeight(".5 oz", 142)).toBe(false);
  });

  it("leaves out a weight per area and a rate, which are not what a thing weighs", () => {
    // a fabric spec read as the item's weight would back a number the page never gave
    expect(read("Fabric: DCF 1.0 oz/yd²")).toEqual([]);
    expect(read("Shell: 36 g/m2 ripstop")).toEqual([]);
    expect(read("40 gsm nylon")).toEqual([]);
    expect(read("Burns 12 g/hr on low")).toEqual([]);
    expect(read("2.5 oz per square yard")).toEqual([]);
    // a slash before a number is the same weight in another unit
    expect(read("Weight: 539 g / 19 oz")).toEqual([539, 539]);
    expect(read("36 oz/1022 g")).toEqual([1022, 1021]);
    expect(quoteBacksWeight("Fabric: DCF 1.0 oz/yd²", 28)).toBe(false);
  });
});
