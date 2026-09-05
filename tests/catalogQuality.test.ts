import { describe, expect, it } from "vitest";
import { isVariantRedundant, normalizeVariant } from "../shared/catalogQuality";

describe("normalizeVariant", () => {
  const cases: [string, string][] = [
    // orphan punctuation from an empty leading dimension
    ["/ M", "M"],
    [", 18F", "18F"],
    // fabric / size — slash is a dimension separator
    ["Ultra 200X / M", "Ultra 200X, M"],
    ["UltraGrid / M", "UltraGrid, M"],
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
    // "Size" prefix drops before a letter size, and only there
    ["Size M", "M"],
    ["120gsm, Size M", "120gsm, M"],
    ["Size D", "Size D"],
    ["Size 9", "Size 9"],
    // a gender prefix and its letter size are one dimension
    ["Men's, M", "Men's M"],
    ["Women's, XS/S", "Women's XS/S"],
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
    ["Ultra 200X, M", "Ultra 200X, M"],
    // quantity phrasing
    ["3 Pack", "3-pack"],
    ["Set of 4, 55mm", "set of 4, 55mm"],
    ["Sleeve of 10", "sleeve of 10"],
    // "|" is a non-canonical separator (copied from a manufacturer quote) → comma
    ["M's 9 | W's 10 US", "M's 9, W's 10 US"],
    // already-canonical / no-op
    ["Men's M", "Men's M"],
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
