import { describe, expect, it } from "vitest";
import { catalogCategories, categoryForGearType, emergingBrandTokens, isBrandedTypedItem, isVariantRedundant, normKey, normalizeVariant, quoteBacksWeight, splitKnownBrand, weightsInQuote } from "../shared/catalogQuality";

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

  it("reads grams and kilograms spelled out, and no decimal comma's last digits", () => {
    expect(read("This product weighs 169 grams in size M.")).toEqual([169]);
    expect(read("Weight | 100 Grams")).toEqual([100]);
    expect(read("100 gr")).toEqual([100]);
    expect(read("1.2 kilograms")).toEqual([1200]);
    expect(read("2 kilos")).toEqual([2000]);
    expect(read("Range: 5 kilometres")).toEqual([]);
    expect(quoteBacksWeight("Gewicht: 1,2 kg", 2000)).toBe(false);
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

  it.each([
    ["a comma list before one unit", "hemp weight : xs-xl: 8.3, 8.8, 9.3, 10.3, 11.4 oz", [235, 249, 264, 292, 323]],
    ["slash lists in two units", "13/19 Oz. | 368/538 Grams (weight will vary)", [368, 538, 369, 539]],
    ["a comma list of grams with thousands", "Weights 1,790, 1,850, 1,920 g", [1790, 1850, 1920]],
    ["a range written with to", "claimed weight: 36 to 39 oz depending on options", [1021, 1106]],
    ["a range written with a hyphen", "36-39 oz", [1021, 1106]],
    ["a range written with an en dash, in kilograms", "1.2–1.4 kg", [1200, 1400]],
    // a maker's spread across sizes runs wider than half, up to double
    ["a range across sizes", "Weight: 400-700 g (S-XL)", [400, 700]],
    ["a range that doubles", "8-16 oz", [227, 454]],
    ["a range of pounds written with to", "1 to 2 lbs", [454, 907]],
    // two single digits that no ruler divides by are a list, not a fraction
    ["a slash list of single digits", "8/9 oz", [227, 255]],
  ])("reads every figure of %s", (_, quote, grams) => {
    expect(read(quote)).toEqual(grams);
  });

  it("backs a weight anywhere inside a stated range, and not one outside it", () => {
    expect(quoteBacksWeight("36 to 39 oz", 1060)).toBe(true);
    expect(quoteBacksWeight("36-39 oz", 1021)).toBe(true);
    // either end keeps its own 5%: 1106 g backs up to 1161, 1021 down to 970
    expect(quoteBacksWeight("36-39 oz", 1180)).toBe(false);
    expect(quoteBacksWeight("36-39 oz", 940)).toBe(false);
    // every size in a list, not only the last
    expect(quoteBacksWeight("xs-xl: 8.3, 8.8, 9.3, 10.3, 11.4 oz", 249)).toBe(true);
    expect(quoteBacksWeight("13/19 Oz.", 369)).toBe(true);
  });

  it.each([
    ["a size and a weight in one sentence", "Size 10, 11.5 oz", [326]],
    ["a size and a weight across a spaced dash", "Size 9 - 12 oz", [340]],
    ["a pound-and-ounce figure", "Weight: 2 lb 3 oz", [992]],
    ["a model number before a weight, spaced", "Flash 22 / 10.6 oz", [301]],
    ["a model number glued to a weight", "Sawyer SP129/85 g", [85]],
    ["a model number and a weight after a comma", "Exos 58, 2.91 lbs", [1320]],
    ["two figures that fall rather than rise", "Weight 2024-12 g", [12]],
    ["a size and a weight across a hyphen", "Weight: UK size 8.5-264g", [264]],
    ["a model number and a weight across a hyphen", "Model 2-480 g", [480]],
    ["a fraction", "1/2 oz", []],
    ["an eighth", "3/8 oz", []],
    ["a size and a weight more than double it", "Size 4-10 oz", [283]],
    ["a decimal comma", "Gewicht: 1,2 kg", []],
  ])("does not read %s as a list", (_, quote, grams) => {
    expect(read(quote)).toEqual(grams);
  });
});

describe("categoryForGearType and catalogCategories: the catalog first, the hand table after", () => {
  const row = (commonName: string | null, categoryHint: string | null) => ({ commonName, categoryHint });
  it("files a gear type where most of its verified rows are, a tie the same whatever the order", () => {
    const filed = catalogCategories([row("Dry bag", "other"), row("dry bag", "other"), row("Dry bag", "sleep"), row("Stuff sack", null), row(null, "cook")]);
    expect(filed).toEqual(new Map([["dry bag", "other"], ["stuff sack", "other"]]));
    const tie = [row("Pillow", "sleep"), row("Pillow", "other")];
    expect(catalogCategories(tie).get("pillow")).toBe("other");
    expect(catalogCategories([...tie].reverse()).get("pillow")).toBe("other");
  });

  it("answers from the catalog for a label it carries, and by the label's words for one it lacks", () => {
    const filed = catalogCategories([row("Sunglasses", "other")]);
    expect(categoryForGearType("sunglasses", filed)).toBe("other");
    expect(categoryForGearType("Sunglasses")).toBe("clothing");
    expect(categoryForGearType("Frame pack", filed)).toBe("pack");
    expect(categoryForGearType("", filed)).toBeNull();
  });
});
