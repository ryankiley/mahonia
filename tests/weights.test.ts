import { describe, expect, it } from "vitest";
import {
  computeTotals,
  effectiveClassification,
  formatWeight,
  formatWeightAuto,
  fromMg,
  parseWeightInput,
  toMg,
} from "../shared/weights";
import type { Folder, Item } from "../shared/types";

const folder = (
  id: string,
  defaultClassification: Folder["defaultClassification"],
): Folder => ({ id, name: id, defaultClassification, sortOrder: 0 });

const item = (over: Partial<Item> & { id: string }): Item => ({
  folderId: null,
  name: over.id,
  unitWeightMg: 0,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

describe("unit conversion", () => {
  it("round-trips grams", () => {
    expect(toMg(820, "g")).toBe(820_000);
    expect(fromMg(820_000, "g")).toBe(820);
  });

  it("converts oz/lb/kg to mg", () => {
    expect(toMg(1, "kg")).toBe(1_000_000);
    expect(toMg(1, "oz")).toBe(28_350); // 28349.523125 rounded
    expect(toMg(1, "lb")).toBe(453_592);
  });
});

describe("parseWeightInput", () => {
  it("parses '1.36kg'", () => {
    expect(parseWeightInput("1.36kg")).toBe(1_360_000);
  });
  it("parses '48oz'", () => {
    expect(parseWeightInput("48oz")).toBe(Math.round(48 * 28_349.523125));
  });
  it("parses compound '2 lb 3 oz'", () => {
    const expected = Math.round(2 * 453_592.37 + 3 * 28_349.523125);
    expect(parseWeightInput("2 lb 3 oz")).toBe(expected);
  });
  it("parses a bare number using the default unit", () => {
    expect(parseWeightInput("820", "g")).toBe(820_000);
    expect(parseWeightInput("1.5", "kg")).toBe(1_500_000);
  });
  it("strips thousands separators", () => {
    expect(parseWeightInput("1,360 g")).toBe(1_360_000);
  });
  it("reads a comma as a DECIMAL point (comma-decimal locales)", () => {
    // "1,5 kg" means 1.5 kg, not 15 kg — the bug that silently 10x'd weights
    expect(parseWeightInput("1,5 kg")).toBe(1_500_000);
    expect(parseWeightInput("1,36 kg")).toBe(1_360_000);
    expect(parseWeightInput("540,5 g")).toBe(540_500);
  });
  it("disambiguates mixed separators by rightmost = decimal", () => {
    expect(parseWeightInput("1,234.56 g")).toBe(Math.round(1234.56 * 1000)); // US grouping
    expect(parseWeightInput("1.234,56 g")).toBe(Math.round(1234.56 * 1000)); // EU grouping
  });
  it("returns null for junk", () => {
    expect(parseWeightInput("")).toBeNull();
    expect(parseWeightInput("stuff sack")).toBeNull();
  });
});

describe("effectiveClassification (item override ?? folder default)", () => {
  const folders = [folder("body", "worn"), folder("kitchen", "base")];
  it("inherits the folder default", () => {
    expect(
      effectiveClassification(item({ id: "a", folderId: "body" }), folders),
    ).toBe("worn");
  });
  it("uses the per-item override when set", () => {
    expect(
      effectiveClassification(
        item({ id: "b", folderId: "body", classification: "base" }),
        folders,
      ),
    ).toBe("base");
  });
  it("falls back to base when no folder", () => {
    expect(
      effectiveClassification(item({ id: "c", folderId: "ghost" }), folders),
    ).toBe("base");
  });
});

describe("computeTotals: base = total − worn − consumable", () => {
  const folders = [
    folder("pack", "base"),
    folder("body", "worn"),
    folder("food", "consumable"),
  ];
  const items: Item[] = [
    item({ id: "tent", folderId: "pack", unitWeightMg: 820_000, qty: 1 }),
    item({ id: "jacket", folderId: "body", unitWeightMg: 300_000, qty: 1 }),
    item({ id: "bars", folderId: "food", unitWeightMg: 60_000, qty: 5 }),
    // per-item override: this puffy lives in "body" but will be carried
    item({
      id: "puffy",
      folderId: "body",
      unitWeightMg: 250_000,
      qty: 1,
      classification: "base",
    }),
  ];

  it("computes rollups with inheritance + override", () => {
    const t = computeTotals({ folders, items });
    expect(t.totalMg).toBe(820_000 + 300_000 + 300_000 + 250_000); // 1,670,000
    expect(t.wornMg).toBe(300_000); // only the jacket
    expect(t.consumableMg).toBe(300_000); // 5 × 60g
    expect(t.baseMg).toBe(t.totalMg - t.wornMg - t.consumableMg); // 1,070,000
    expect(t.itemCount).toBe(4);
    expect(t.hasWeights).toBe(true);
  });

  it("reports hasWeights=false when every item is weightless", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "x", folderId: "pack" })],
    });
    expect(t.hasWeights).toBe(false);
    expect(t.totalMg).toBe(0);
  });
});

describe("formatWeight", () => {
  it("is strict — shows the selected unit, no auto-promotion", () => {
    expect(formatWeight(1_360_000, "g")).toBe("1,360 g");
    expect(formatWeight(1_360_000, "kg")).toBe("1.36 kg");
  });
  it("keeps small grams in g", () => {
    expect(formatWeight(820_000, "g")).toBe("820 g");
  });
});

describe("formatWeightAuto (magnitude-promoted, for comparison surfaces)", () => {
  it("promotes g→kg at ≥1 kg, stays g below", () => {
    expect(formatWeightAuto(5_000_000)).toBe("5 kg"); // not "5,000 g" — the bug
    expect(formatWeightAuto(1_360_000)).toBe("1.36 kg");
    expect(formatWeightAuto(1_000_000)).toBe("1 kg"); // threshold is inclusive
    expect(formatWeightAuto(999_000)).toBe("999 g");
    expect(formatWeightAuto(820_000)).toBe("820 g");
  });
  it("promotes oz→lb by magnitude when system is imperial", () => {
    expect(formatWeightAuto(700_000, { system: "imperial" })).toMatch(/ lb$/);
    expect(formatWeightAuto(300_000, { system: "imperial" })).toMatch(/ oz$/);
  });
  it("honours withUnit: false", () => {
    expect(formatWeightAuto(5_000_000, { withUnit: false })).toBe("5");
  });
});
