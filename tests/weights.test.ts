import { describe, expect, it } from "vitest";
import {
  computeTotals,
  effectiveClassification,
  entryUnitFromInput,
  formatWeight,
  formatWeightAuto,
  fromMg,
  groupItemsByFolder,
  groupItemsByParent,
  groupLineMg,
  nextSortOrder,
  parseWeightInput,
  sortedFolderItems,
  splitWornQty,
  toMg,
  totalsChips,
  ungroupedTopLevel,
} from "../shared/weights";
import type { Folder, Item } from "../shared/types";
import { totals } from "./helpers/totals";

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

describe("entryUnitFromInput — which unit did the typist NAME?", () => {
  it("returns the named unit", () => {
    expect(entryUnitFromInput("3.8 oz")).toBe("oz");
    expect(entryUnitFromInput("1.36kg")).toBe("kg");
    expect(entryUnitFromInput("820 g")).toBe("g");
  });
  it("accepts the same vocabulary the parser does", () => {
    expect(entryUnitFromInput("2 pounds")).toBe("lb");
    expect(entryUnitFromInput("500 GRAMS")).toBe("g");
  });
  it("returns null for a bare number — no choice was made", () => {
    expect(entryUnitFromInput("820")).toBeNull();
    expect(entryUnitFromInput("1,5")).toBeNull();
  });
  it("returns null for a compound — no single unit to read back in", () => {
    // the sum is the point; picking either half would misreport the entry
    expect(entryUnitFromInput("2 lb 3 oz")).toBeNull();
  });
  it("collapses a repeated unit to that one unit", () => {
    expect(entryUnitFromInput("2 oz 3 oz")).toBe("oz");
  });
  it("returns null for junk and empty input", () => {
    expect(entryUnitFromInput("")).toBeNull();
    expect(entryUnitFromInput("stuff sack")).toBeNull();
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

  it("rolls base + consumable into carried — everything but what's worn", () => {
    const t = computeTotals({ folders, items });
    expect(t.carriedMg).toBe(t.baseMg + t.consumableMg); // 1,370,000
    expect(t.carriedMg).toBe(t.totalMg - t.wornMg);
  });

  it("counts a partly-worn base line's worn units OUT of carried", () => {
    // 3 pairs of socks, wearing 1 — carried is the 2 in the pack, not all 3
    const t = computeTotals({
      folders,
      items: [item({ id: "socks", folderId: "pack", unitWeightMg: 100_000, qty: 3, wornQty: 1 })],
    });
    expect(t.carriedMg).toBe(200_000);
  });

  it("equals the total when nothing is worn", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "tent", folderId: "pack", unitWeightMg: 820_000 })],
    });
    expect(t.carriedMg).toBe(t.totalMg);
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

describe("computeTotals: calories", () => {
  const folders = [folder("pack", "base"), folder("food", "consumable")];

  it("sums kcal per UNIT across the line, like weight", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "bars", folderId: "food", kcal: 250, qty: 4 })],
    });
    expect(t.kcalTotal).toBe(1000);
    expect(t.hasKcal).toBe(true);
  });

  it("counts a row whose CONSUMABLE class is inherited from its folder", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "dinner", folderId: "food", kcal: 800 })],
    });
    expect(t.kcalTotal).toBe(800);
  });

  it("ignores kcal left behind on a row that is no longer consumable", () => {
    // demote a food row to base: its stored kcal stays in the data (so flipping it
    // back restores it) but must not be counted while the row isn't consumable
    const t = computeTotals({
      folders,
      items: [item({ id: "bar", folderId: "food", classification: "base", kcal: 250 })],
    });
    expect(t.kcalTotal).toBe(0);
    expect(t.hasKcal).toBe(false);
  });

  it("ignores kcal on a worn row", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "jacket", folderId: "pack", classification: "worn", kcal: 99 })],
    });
    expect(t.kcalTotal).toBe(0);
  });

  it("reports hasKcal=false when nothing carries a value", () => {
    const t = computeTotals({
      folders,
      items: [item({ id: "food", folderId: "food", unitWeightMg: 500_000 })],
    });
    expect(t.hasKcal).toBe(false);
    expect(t.kcalTotal).toBe(0);
  });

  it("keeps calories independent of the weight partition", () => {
    const t = computeTotals({
      folders,
      items: [
        item({ id: "tent", folderId: "pack", unitWeightMg: 820_000 }),
        item({ id: "bars", folderId: "food", unitWeightMg: 100_000, kcal: 250, qty: 2 }),
      ],
    });
    // the three weight slices still partition the total, untouched by kcal
    expect(t.baseMg + t.wornMg + t.consumableMg).toBe(t.totalMg);
    expect(t.kcalTotal).toBe(500);
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
  // The share views (/l, /s) render weights server-side, so the separators must not
  // depend on the ambient locale — the render lambda's and the visitor's differ, and
  // the mismatch shows up as a hydration patch after paint. Asserting against an
  // explicitly non-en formatter proves the pin holds regardless of where this runs.
  it("formats identically whatever the ambient locale is", () => {
    const de = (1.36).toLocaleString("de-DE", { maximumFractionDigits: 2 });
    expect(de).toBe("1,36"); // sanity: this machine's ICU really does have de-DE
    // grouping separator (thousands) and decimal separator both stay pinned
    expect(formatWeight(1_360_000, "g")).toBe("1,360 g");
    expect(formatWeight(1_360_000, "kg")).toBe("1.36 kg");
    expect(formatWeight(2_000, "kg")).toBe("<0.01 kg"); // the "<step" label too
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

describe("groupItemsByFolder", () => {
  it("orders each group by drag order (sortOrder), ungrouped excluded", () => {
    const items = [
      item({ id: "light", folderId: "f1", unitWeightMg: 10_000, sortOrder: 1 }),
      item({ id: "heavy", folderId: "f1", unitWeightMg: 90_000, sortOrder: 0 }),
      item({ id: "x", folderId: "f2", sortOrder: 5 }),
      item({ id: "y", folderId: "f2", sortOrder: 4 }),
      item({ id: "loose", folderId: null, sortOrder: 0 }),
    ];
    const map = groupItemsByFolder(items);
    expect(map.get("f1")!.map((i) => i.id)).toEqual(["heavy", "light"]);
    expect(map.get("f2")!.map((i) => i.id)).toEqual(["y", "x"]);
    expect(map.has(null as any)).toBe(false); // ungrouped never grouped
  });
});

describe("sortedFolderItems", () => {
  it("returns just this folder's items in drag order", () => {
    const f: Folder = { id: "f1", name: "f1", defaultClassification: "base", sortOrder: 0 };
    const items = [
      item({ id: "c", folderId: "f1", name: "Cook pot", sortOrder: 1 }),
      item({ id: "a", folderId: "f1", name: "Axe", sortOrder: 0 }),
      item({ id: "other", folderId: "f2", name: "Zzz", sortOrder: 0 }),
    ];
    expect(sortedFolderItems(items, f).map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("nesting (a nested item is just an item with a parentId)", () => {
  it("groupLineMg = own + children", () => {
    const items = [
      item({ id: "tent", folderId: "f1", unitWeightMg: 0 }), // a pure container
      item({ id: "fly", folderId: "f1", parentId: "tent", unitWeightMg: 720_000, sortOrder: 1 }),
      item({ id: "inner", folderId: "f1", parentId: "tent", unitWeightMg: 840_000, sortOrder: 0 }),
      item({ id: "stakes", folderId: "f1", parentId: "tent", unitWeightMg: 12_000, qty: 8, sortOrder: 2 }),
      item({ id: "solo", folderId: "f1", unitWeightMg: 5_000 }),
    ];
    // 0 (own) + 840k + 720k + 8×12k = 1,656,000
    expect(groupLineMg(items[0]!, items)).toBe(1_656_000);
  });

  it("computeTotals counts every item once by its OWN class — parent + children, no double", () => {
    // a container tent (own 0) with three parts; totals sum each item's own line so the
    // group total = Σ children, counted exactly once.
    const items = [
      item({ id: "tent", folderId: "f1", unitWeightMg: 0 }),
      item({ id: "inner", folderId: "f1", parentId: "tent", unitWeightMg: 840_000 }),
      item({ id: "fly", folderId: "f1", parentId: "tent", unitWeightMg: 720_000 }),
    ];
    const t = computeTotals({ folders: [folder("f1", "base")], items });
    expect(t.totalMg).toBe(1_560_000);
    expect(t.baseMg).toBe(1_560_000);
  });

  it("a nested item carries its own class — a cook kit's consumable fuel lands in consumable", () => {
    const items = [
      item({ id: "cook", folderId: "f1", unitWeightMg: 0 }),
      item({ id: "pot", folderId: "f1", parentId: "cook", unitWeightMg: 300_000 }), // inherits base
      item({ id: "fuel", folderId: "f1", parentId: "cook", unitWeightMg: 15_000, qty: 8, classification: "consumable" }),
    ];
    const t = computeTotals({ folders: [folder("f1", "base")], items });
    expect(t.totalMg).toBe(420_000);
    expect(t.consumableMg).toBe(120_000); // 8 × 15 g fuel
    expect(t.baseMg).toBe(300_000); // the pot
  });

  it("a nested item inherits its (parent's) folder default class", () => {
    // children share the parent's folderId, so they inherit the folder default like any item
    const items = [
      item({ id: "gloves", folderId: "fw", unitWeightMg: 0 }),
      item({ id: "shell", folderId: "fw", parentId: "gloves", unitWeightMg: 60_000 }), // inherits worn
      item({ id: "liner", folderId: "fw", parentId: "gloves", unitWeightMg: 30_000, classification: "base" }),
    ];
    const t = computeTotals({ folders: [folder("fw", "worn")], items });
    expect(t.wornMg).toBe(60_000);
    expect(t.baseMg).toBe(30_000);
  });

  it("groupItemsByFolder / sortedFolderItems return TOP-LEVEL rows only (children render nested)", () => {
    const f: Folder = { id: "f1", name: "f1", defaultClassification: "base", sortOrder: 0 };
    const items = [
      item({ id: "tent", folderId: "f1", sortOrder: 0 }),
      item({ id: "fly", folderId: "f1", parentId: "tent", sortOrder: 0 }),
      item({ id: "pack", folderId: "f1", sortOrder: 1 }),
    ];
    expect(groupItemsByFolder(items).get("f1")!.map((i) => i.id)).toEqual(["tent", "pack"]);
    expect(sortedFolderItems(items, f).map((i) => i.id)).toEqual(["tent", "pack"]);
  });

  it("groupItemsByParent: children under their parent id, in sortOrder", () => {
    const items = [
      item({ id: "tent", folderId: "f1", sortOrder: 0 }),
      item({ id: "fly", folderId: "f1", parentId: "tent", sortOrder: 1 }),
      item({ id: "inner", folderId: "f1", parentId: "tent", sortOrder: 0 }),
      item({ id: "cook", folderId: "f1", sortOrder: 1 }),
      item({ id: "pot", folderId: "f1", parentId: "cook", sortOrder: 0 }),
      item({ id: "solo", folderId: "f1", sortOrder: 2 }),
    ];
    const map = groupItemsByParent(items);
    expect(map.get("tent")!.map((i) => i.id)).toEqual(["inner", "fly"]);
    expect(map.get("cook")!.map((i) => i.id)).toEqual(["pot"]);
    expect(map.has("solo")).toBe(false); // leaves get no entry (rows fall back to a shared [])
  });
});

describe("ungroupedTopLevel — the 'Ungrouped' section's rows", () => {
  it("keeps only folderless TOP-LEVEL rows (children render under their parent)", () => {
    const items = [
      item({ id: "loose", folderId: null, sortOrder: 0 }),
      item({ id: "kid", folderId: null, parentId: "loose", sortOrder: 0 }),
      item({ id: "homed", folderId: "f1", sortOrder: 0 }),
    ];
    expect(ungroupedTopLevel(items).map((i) => i.id)).toEqual(["loose"]);
  });
});

describe("totalsChips — the breakdown TotalsBar and the social card share", () => {
  it("shows the categories that carry weight, in fixed order", () => {
    const chips = totalsChips(
      totals({ baseMg: 6_000_000, wornMg: 1_400_000, consumableMg: 800_000 }),
    );
    expect(chips).toEqual([
      { label: "Base", mg: 6_000_000 },
      { label: "Worn", mg: 1_400_000 },
      { label: "Consumable", mg: 800_000 },
    ]);
  });

  it("drops zero categories (no 'Consumable 0 g' noise)", () => {
    const chips = totalsChips(totals({ baseMg: 6_000_000, wornMg: 1_400_000 }));
    expect(chips.map((c) => c.label)).toEqual(["Base", "Worn"]);
  });

  it("drops a lone Base chip — it would just restate the headline total", () => {
    expect(totalsChips(totals({ baseMg: 6_000_000 }))).toEqual([]);
  });

  it("keeps a lone Worn or Consumable chip — a fact the headline doesn't carry", () => {
    expect(totalsChips(totals({ wornMg: 500_000 }))).toEqual([
      { label: "Worn", mg: 500_000 },
    ]);
    expect(totalsChips(totals({ consumableMg: 500_000 }))).toEqual([
      { label: "Consumable", mg: 500_000 },
    ]);
  });
});
