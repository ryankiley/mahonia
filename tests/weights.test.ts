import { describe, expect, it } from "vitest";
import {
  compareItemsBy,
  computeTotals,
  effectiveClassification,
  formatWeight,
  formatWeightAuto,
  fromMg,
  groupItemsByFolder,
  nextSortOrder,
  parseWeightInput,
  sortedFolderItems,
  splitWornQty,
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

describe("splitWornQty — the wornQty split applies only to base lines", () => {
  it("returns the clamped worn count on a base line", () => {
    expect(splitWornQty({ qty: 3, wornQty: 1 }, "base")).toBe(1);
    expect(splitWornQty({ qty: 3, wornQty: 5 }, "base")).toBe(3); // clamped to qty
    expect(splitWornQty({ qty: 3, wornQty: 3 }, "base")).toBe(3); // all worn
  });
  it("returns 0 when absent or on worn/consumable lines", () => {
    expect(splitWornQty({ qty: 3 }, "base")).toBe(0);
    expect(splitWornQty({ qty: 3, wornQty: 1 }, "worn")).toBe(0);
    expect(splitWornQty({ qty: 3, wornQty: 1 }, "consumable")).toBe(0);
  });
});

describe("computeTotals with a worn split (one row, some units worn)", () => {
  const folders = [folder("pack", "base"), folder("body", "worn"), folder("food", "consumable")];

  it("moves the worn portion of a base line into wornMg; the rest stays base", () => {
    // 3 pairs of socks, wearing 1: 1×100g worn, 2×100g base
    const t = computeTotals({
      folders,
      items: [item({ id: "socks", folderId: "pack", unitWeightMg: 100_000, qty: 3, wornQty: 1 })],
    });
    expect(t.totalMg).toBe(300_000);
    expect(t.wornMg).toBe(100_000);
    expect(t.baseMg).toBe(200_000);
    expect(t.consumableMg).toBe(0);
  });

  it("never double-counts on an effective-worn line (folder default)", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "socks", folderId: "body", unitWeightMg: 100_000, qty: 3, wornQty: 1 })],
    });
    expect(t.wornMg).toBe(300_000); // whole line worn; the split is dormant
    expect(t.baseMg).toBe(0);
  });

  it("ignores the split on a consumable line", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "bars", folderId: "food", unitWeightMg: 60_000, qty: 5, wornQty: 2 })],
    });
    expect(t.consumableMg).toBe(300_000);
    expect(t.wornMg).toBe(0);
  });

  it("clamps a stale wornQty > qty and empties base at wornQty === qty", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "socks", folderId: "pack", unitWeightMg: 100_000, qty: 2, wornQty: 9 })],
    });
    expect(t.wornMg).toBe(200_000); // clamped to qty
    expect(t.baseMg).toBe(0);
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
  it("shows a tiny real weight as '<step', not a wrong '0', in coarse units", () => {
    // a 2 g brush would round to 0 in lb/kg — show "less than the smallest step"
    expect(formatWeight(2_000, "lb")).toBe("<0.01 lb");
    expect(formatWeight(2_000, "kg")).toBe("<0.01 kg");
    expect(formatWeight(1_000, "oz")).toBe("<0.1 oz"); // 1 g ≈ 0.035 oz → rounds to 0
    expect(formatWeight(400, "g")).toBe("<1 g"); // 0.4 g → rounds to 0 g
    expect(formatWeight(2_000, "lb", { withUnit: false })).toBe("<0.01");
  });
  it("leaves a genuine zero as '0', and never marks a value that rounds up", () => {
    expect(formatWeight(0, "lb")).toBe("0 lb");
    expect(formatWeight(500_000, "lb")).toBe("1.1 lb"); // sanity: normal path unaffected
    expect(formatWeight(5_000, "lb")).toBe("0.01 lb"); // 5 g rounds up to the step, not below
  });
  it("raw: keeps a bare parseable number for editable fields", () => {
    expect(formatWeight(2_000, "lb", { raw: true })).toBe("0 lb");
    expect(formatWeight(2_000, "lb", { withUnit: false, raw: true })).toBe("0");
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

describe("nextSortOrder — new items append at the folder's bottom", () => {
  it("is 0 for an empty folder", () => {
    expect(nextSortOrder([], "f1")).toBe(0);
    expect(nextSortOrder([item({ id: "a", folderId: "other", sortOrder: 4 })], "f1")).toBe(0);
  });
  it("appends after a dense 0..n-1 folder", () => {
    const items = [
      item({ id: "a", folderId: "f1", sortOrder: 0 }),
      item({ id: "b", folderId: "f1", sortOrder: 1 }),
    ];
    expect(nextSortOrder(items, "f1")).toBe(2);
  });
  it("appends after the max when deletes/drag-outs left holes (count-based would land mid-folder)", () => {
    // folder had 0..4; two rows were dragged out or deleted → holes at 1,2
    const items = [
      item({ id: "a", folderId: "f1", sortOrder: 0 }),
      item({ id: "d", folderId: "f1", sortOrder: 3 }),
      item({ id: "e", folderId: "f1", sortOrder: 4 }),
    ];
    expect(nextSortOrder(items, "f1")).toBe(5); // NOT 3 (the count), which sorts above e
  });
  it("scopes to the requested folder, including ungrouped (null)", () => {
    const items = [
      item({ id: "a", folderId: "f1", sortOrder: 7 }),
      item({ id: "b", folderId: null, sortOrder: 2 }),
    ];
    expect(nextSortOrder(items, null)).toBe(3);
    expect(nextSortOrder(items, "f1")).toBe(8);
  });
});

describe("per-folder sort (compareItemsBy)", () => {
  // sortOrder is deliberately the reverse of both name and weight order, so each mode
  // has to actually re-order (and manual has to preserve this "hand-dragged" order)
  const mk = () => [
    item({ id: "tent", name: "Tent", brand: "Zpacks", unitWeightMg: 500_000, qty: 1, sortOrder: 0 }),
    item({ id: "socks", name: "socks", unitWeightMg: 40_000, qty: 3, sortOrder: 1 }), // 120g line
    item({ id: "apple", name: "Apple", unitWeightMg: 200_000, qty: 1, sortOrder: 2 }),
  ];
  const ids = (arr: Item[]) => arr.map((i) => i.id);
  const order = (sortBy: Folder["sortBy"]) =>
    ids([...mk()].sort((a, b) => compareItemsBy(sortBy, a, b)));

  it("manual (and undefined/unknown) keeps the drag order (sortOrder)", () => {
    expect(order("manual")).toEqual(["tent", "socks", "apple"]);
    expect(order(undefined)).toEqual(["tent", "socks", "apple"]);
    expect(order("bogus" as any)).toEqual(["tent", "socks", "apple"]);
  });

  it("name sorts A–Z case-insensitively on the flat display name", () => {
    // "Zpacks Tent" (brand folded in) > "Apple" > "socks"; case-insensitive puts
    // lowercase "socks" after "Apple", not at the end where ASCII would place it
    expect(order("name")).toEqual(["apple", "socks", "tent"]);
  });

  it("heaviest / lightest key off the LINE weight (qty × unit), not unit weight", () => {
    // lines: tent 500g, apple 200g, socks 3×40g = 120g
    expect(order("heaviest")).toEqual(["tent", "apple", "socks"]);
    expect(order("lightest")).toEqual(["socks", "apple", "tent"]);
  });

  it("breaks ties on sortOrder so equal-weight runs keep their manual order", () => {
    const tied = [
      item({ id: "b", name: "b", unitWeightMg: 100_000, sortOrder: 1 }),
      item({ id: "a", name: "a", unitWeightMg: 100_000, sortOrder: 0 }),
    ];
    expect(tied.slice().sort((x, y) => compareItemsBy("heaviest", x, y)).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("groupItemsByFolder honors each folder's sortBy", () => {
  it("orders each group by its own folder's sort, ungrouped excluded", () => {
    const folders: Folder[] = [
      { id: "f1", name: "f1", defaultClassification: "base", sortBy: "heaviest", sortOrder: 0 },
      { id: "f2", name: "f2", defaultClassification: "base", sortOrder: 1 }, // manual
    ];
    const items = [
      item({ id: "light", folderId: "f1", unitWeightMg: 10_000, sortOrder: 0 }),
      item({ id: "heavy", folderId: "f1", unitWeightMg: 90_000, sortOrder: 1 }),
      item({ id: "x", folderId: "f2", sortOrder: 5 }),
      item({ id: "y", folderId: "f2", sortOrder: 4 }),
      item({ id: "loose", folderId: null, sortOrder: 0 }),
    ];
    const map = groupItemsByFolder(items, folders);
    expect(map.get("f1")!.map((i) => i.id)).toEqual(["heavy", "light"]); // sorted by weight
    expect(map.get("f2")!.map((i) => i.id)).toEqual(["y", "x"]); // manual = sortOrder
    expect(map.has(null as any)).toBe(false); // ungrouped never grouped
  });

  it("with no folders passed, every group falls back to manual sortOrder", () => {
    const items = [
      item({ id: "b", folderId: "f1", unitWeightMg: 90_000, sortOrder: 1 }),
      item({ id: "a", folderId: "f1", unitWeightMg: 10_000, sortOrder: 0 }),
    ];
    expect(groupItemsByFolder(items).get("f1")!.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("sortedFolderItems", () => {
  it("returns just this folder's items in its chosen order", () => {
    const f: Folder = { id: "f1", name: "f1", defaultClassification: "base", sortBy: "name", sortOrder: 0 };
    const items = [
      item({ id: "c", folderId: "f1", name: "Cook pot", sortOrder: 0 }),
      item({ id: "a", folderId: "f1", name: "Axe", sortOrder: 1 }),
      item({ id: "other", folderId: "f2", name: "Zzz", sortOrder: 0 }),
    ];
    expect(sortedFolderItems(items, f).map((i) => i.id)).toEqual(["a", "c"]);
  });
});
