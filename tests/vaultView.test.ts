// /gear's view pipeline — search → sort → group.
//
// Plain node, no Nuxt and no database: that is the whole reason shared/vaultView.ts
// exists as its own module. The rules worth pinning here are the ones that are
// invisible until they're wrong — a limit that silently truncates, a heading that
// vanishes.

import { describe, expect, it } from "vitest";
import { vaultRow as row } from "./helpers/vault";
import type { VaultEntry } from "../shared/vault";
import {
  formatKcalDensity,
  groupVaultByKind,
  kcalPerGram,
  matchesElsewhere,
  searchVaultRows,
  sortVaultRows,
  vaultTabOf,
} from "../shared/vaultView";


const names = (rows: VaultEntry[]) => rows.map((r) => r.name);

describe("searchVaultRows — the ranker, uncapped", () => {
  it("returns ALL matches, not the menu's six", () => {
    // rankVaultRows defaults to VAULT_SEARCH_LIMIT so an autocomplete can't push the
    // catalog off-screen. This page IS the list — six of twelve would hide gear you own.
    const rows = Array.from({ length: 12 }, (_, i) => row({ name: `Duplex ${i}` }));
    expect(searchVaultRows(rows, "duplex")).toHaveLength(12);
  });

  it("a ONE-character query falls back to substring instead of returning nothing", () => {
    // The ranker bails under two characters. In a menu that reads "keep typing"; on a
    // page it reads "you own nothing beginning with t".
    const rows = [row({ name: "Tent" }), row({ name: "Quilt" })];
    expect(names(searchVaultRows(rows, "t"))).toEqual(["Tent", "Quilt"]); // both contain a t
    expect(names(searchVaultRows(rows, "q"))).toEqual(["Quilt"]);
  });

  it("folds apostrophes on the one-character path", () => {
    const rows = [row({ name: "Ryan’s repair kit" })];
    expect(searchVaultRows(rows, "’")).toHaveLength(1);
    expect(searchVaultRows(rows, "'")).toHaveLength(1);
  });

  it("survives a typo, which the old substring filter could not", () => {
    const rows = [row({ brand: "Zpacks", name: "Duplex" }), row({ name: "Quilt" })];
    expect(names(searchVaultRows(rows, "duplx"))).toEqual(["Duplex"]);
  });

  it("finds gear by its type, not just its name", () => {
    const rows = [row({ name: "PocketRocket", commonName: "Stove" }), row({ name: "Quilt" })];
    expect(names(searchVaultRows(rows, "stove"))).toEqual(["PocketRocket"]);
  });

  it("an empty query is the whole set, untouched", () => {
    const rows = [row(), row()];
    expect(searchVaultRows(rows, "   ")).toBe(rows);
  });
});

describe("sortVaultRows — the order, across the whole vault", () => {
  it("heaviest and lightest are mirror images", () => {
    const rows = [
      row({ name: "Mid", weightMg: 500 }),
      row({ name: "Heavy", weightMg: 900 }),
      row({ name: "Light", weightMg: 100 }),
    ];
    expect(names(sortVaultRows(rows, "heaviest"))).toEqual(["Heavy", "Mid", "Light"]);
    expect(names(sortVaultRows(rows, "lightest"))).toEqual(["Light", "Mid", "Heavy"]);
  });

  it("A–Z ignores case and reads numbers as numbers", () => {
    const rows = [row({ name: "Bag 10" }), row({ name: "apple" }), row({ name: "Bag 2" })];
    expect(names(sortVaultRows(rows, "az"))).toEqual(["apple", "Bag 2", "Bag 10"]);
  });

  it("A–Z sorts on the DISPLAY name, brand included", () => {
    const rows = [row({ brand: "Zpacks", name: "Arc" }), row({ brand: "Alpha", name: "Zed" })];
    expect(names(sortVaultRows(rows, "az"))).toEqual(["Zed", "Arc"]);
  });

  it("recently used is newest first", () => {
    const rows = [
      row({ name: "Old", lastUsedAt: "2026-01-01T00:00:00.000Z" }),
      row({ name: "New", lastUsedAt: "2026-08-09T00:00:00.000Z" }),
    ];
    expect(names(sortVaultRows(rows, "recent"))).toEqual(["New", "Old"]);
  });

  it("most used is by timesSeen", () => {
    const rows = [row({ name: "Rare", timesSeen: 1 }), row({ name: "Workhorse", timesSeen: 30 })];
    expect(names(sortVaultRows(rows, "most"))).toEqual(["Workhorse", "Rare"]);
  });

  it("calorie dense is calories per gram, with the unweighed and uncounted last", () => {
    const rows = [
      row({ name: "Dinner", kcal: 800, weightMg: 181_000 }), // 4.4 kcal/g
      row({ name: "Unweighed", kcal: 300, weightMg: 0 }),
      row({ name: "Pretzels", kcal: 470, weightMg: 93_600 }), // 5.0 kcal/g
      row({ name: "Uncounted", weightMg: 50_000 }),
      row({ name: "Fruit pouch", kcal: 70, weightMg: 113_400 }), // 0.6 kcal/g
    ];
    expect(names(sortVaultRows(rows, "dense"))).toEqual(["Pretzels", "Dinner", "Fruit pouch", "Unweighed", "Uncounted"]);
  });

  it("most calories is by kcal, the uncounted last", () => {
    const rows = [row({ name: "Bar", kcal: 250 }), row({ name: "Unknown" }), row({ name: "Dinner", kcal: 800 })];
    expect(names(sortVaultRows(rows, "kcal"))).toEqual(["Dinner", "Bar", "Unknown"]);
  });

  it("ties break on id, so the order is total", () => {
    const a = row({ name: "A", weightMg: 100 });
    const b = row({ name: "B", weightMg: 100 });
    expect(sortVaultRows([b, a], "heaviest").map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("leaves the input array alone", () => {
    const rows = [row({ weightMg: 1 }), row({ weightMg: 9 })];
    const before = rows.map((r) => r.id);
    sortVaultRows(rows, "heaviest");
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("groupVaultByKind — the default view", () => {
  it("puts kits first, then each family in the icon set's order, then Other", () => {
    const rows = [
      row({ name: "Mug", commonName: "Cup" }),
      row({ name: "Cook kit", kind: "kit", parts: [] }),
      row({ name: "Duplex", commonName: "Tent" }),
      row({ name: "Mystery widget", commonName: "Widget" }),
    ];
    const out = groupVaultByKind(rows);
    expect(out.map((s) => s.label)).toEqual(["Kits", "Shelter", "Kitchen", "Other"]);
    expect(out.map((s) => names(s.entries))).toEqual([["Cook kit"], ["Duplex"], ["Mug"], ["Mystery widget"]]);
  });

  it("files a piece by the icon you picked over the one its type would give", () => {
    const out = groupVaultByKind([row({ name: "Odd one", commonName: "Tent", icon: "stove" })]);
    expect(out.map((s) => s.key)).toEqual(["kitchen"]);
  });

  it("leaves out a kind with nothing in it, and keeps the rows' own order inside one", () => {
    const out = groupVaultByKind([row({ name: "B", commonName: "Tent" }), row({ name: "A", commonName: "Tent" })]);
    expect(out).toHaveLength(1);
    expect(names(out[0]!.entries)).toEqual(["B", "A"]);
  });

  it("keeps a piece that is in a kit as a row of its own kind too", () => {
    const pot = row({ name: "Pot", commonName: "Pot", inKits: [99] });
    const out = groupVaultByKind([row({ id: 99, name: "Cook kit", kind: "kit", parts: [] }), pot]);
    expect(out.map((s) => names(s.entries))).toEqual([["Cook kit"], ["Pot"]]);
  });
});

describe("searchVaultRows — other scripts", () => {
  it("matches Chinese names without unrelated results", () => {
    const rows = [row({ name: "SmallRig 电池" }), row({ name: "炉头" })];
    expect(names(searchVaultRows(rows, "电池"))).toEqual(["SmallRig 电池"]);
    expect(names(searchVaultRows(rows, "smallrig 电池"))).toEqual(["SmallRig 电池"]);
    expect(names(searchVaultRows(rows, "电"))).toEqual(["SmallRig 电池"]);
    expect(searchVaultRows(rows, "熊罐")).toEqual([]);
  });

  it("a single ideograph is a whole query, ranked like a word", () => {
    const rows = [row({ name: "炉头" }), row({ name: "眼罩" })];
    expect(names(searchVaultRows(rows, "炉"))).toEqual(["炉头"]);
  });

  it("a single character is a prefix question about the gear", () => {
    const rows = [row({ name: "Tent" }), row({ name: "Pump" })];
    expect(names(searchVaultRows(rows, "t"))).toEqual(["Tent"]);
  });
});

describe("vaultTabOf — Gear, Kits or Food", () => {
  it("puts a kit on Kits, food on Food, and everything else on Gear", () => {
    expect(vaultTabOf(row({ name: "Cook kit", kind: "kit", parts: [] }))).toBe("kits");
    expect(vaultTabOf(row({ name: "Clif Bar", commonName: "Energy bar" }))).toBe("food");
    expect(vaultTabOf(row({ name: "Risotto", commonName: "Dinner" }))).toBe("food");
    expect(vaultTabOf(row({ name: "Skratch", commonName: "Electrolyte mix" }))).toBe("food");
    expect(vaultTabOf(row({ name: "Duplex", commonName: "Tent" }))).toBe("gear");
  });

  it("goes by the kind, not the consumable class: fuel and sunscreen stay gear", () => {
    expect(vaultTabOf(row({ name: "IsoPro 110g", commonName: "Fuel canister", classification: "consumable" }))).toBe("gear");
    expect(vaultTabOf(row({ name: "Anessa", commonName: "Sunscreen", classification: "consumable" }))).toBe("gear");
    // and food a list never classed is still food
    expect(vaultTabOf(row({ name: "Gardetto's", commonName: "Snack" }))).toBe("food");
  });

  it("follows a hand-picked icon, so a new icon moves a piece between tabs", () => {
    expect(vaultTabOf(row({ name: "Mystery tin", commonName: "Tin", icon: "food" }))).toBe("food");
    expect(vaultTabOf(row({ name: "Bar bag", commonName: "Energy bar", icon: "bag" }))).toBe("gear");
  });
});

describe("calorie density — food's own figure", () => {
  it("is calories per gram, and absent when either half is missing", () => {
    expect(kcalPerGram(250, 50_000)).toBe(5);
    // an unweighed or uncounted food has no density, rather than the worst one
    expect(kcalPerGram(250, 0)).toBeNull();
    expect(kcalPerGram(undefined, 50_000)).toBeNull();
    expect(kcalPerGram(0, 50_000)).toBeNull();
  });

  it("reads per ounce in ounces and pounds, per 100 g in grams and kilograms", () => {
    // 5 kcal/g: 500 per 100 g, 142 per ounce
    expect(formatKcalDensity(5, "g")).toBe("500 kcal/100 g");
    expect(formatKcalDensity(5, "kg")).toBe("500 kcal/100 g");
    expect(formatKcalDensity(5, "oz")).toBe("142 kcal/oz");
    expect(formatKcalDensity(5, "lb")).toBe("142 kcal/oz");
  });
});

describe("matchesElsewhere — a search names the other tabs it matched", () => {
  const gear = [
    row({ name: "Duplex", commonName: "Tent" }),
    row({ brand: "Clif", name: "Nut Butter Bar", commonName: "Energy bar" }),
    row({ brand: "Clif", name: "Bloks", commonName: "Energy chews" }),
    row({ name: "Clif kit", kind: "kit", parts: [] }),
  ];

  it("counts each other tab's matches, in the tabs' order, leaving out the open one", () => {
    expect(matchesElsewhere(gear, "clif", "gear")).toEqual([
      { tab: "kits", count: 1 },
      { tab: "food", count: 2 },
    ]);
    expect(matchesElsewhere(gear, "clif", "food")).toEqual([{ tab: "kits", count: 1 }]);
  });

  it("leaves out a tab with no match, and says nothing for an empty search", () => {
    expect(matchesElsewhere(gear, "duplex", "food")).toEqual([{ tab: "gear", count: 1 }]);
    expect(matchesElsewhere(gear, "duplex", "gear")).toEqual([]);
    expect(matchesElsewhere(gear, "  ", "gear")).toEqual([]);
  });
});
