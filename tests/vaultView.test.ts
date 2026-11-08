// /gear's view pipeline — filter → search → sort → group.
//
// Plain node, no Nuxt and no database: that is the whole reason shared/vaultView.ts
// exists as its own module. The rules worth pinning here are the ones that are
// invisible until they're wrong — a limit that silently truncates, a filter that
// matches almost nothing, a heading that vanishes.

import { describe, expect, it } from "vitest";
import { vaultRow as row } from "./helpers/vault";
import type { VaultEntry } from "../shared/vault";
import {
  filterVaultRows,
  groupVaultByKind,
  searchVaultRows,
  sortVaultRows,
} from "../shared/vaultView";


const names = (rows: VaultEntry[]) => rows.map((r) => r.name);

describe("filterVaultRows — WHICH gear", () => {
  it("returns everything under 'all', without copying", () => {
    const rows = [row(), row()];
    expect(filterVaultRows(rows, "all")).toBe(rows);
  });

  it("'base' matches an ABSENT classification as well as the literal", () => {
    // The trap: capture drops the field when a list row inherited its folder's
    // default, so most base gear carries no value at all. A `=== "base"` filter would
    // hide nearly everything and look like a broken vault.
    const rows = [
      row({ name: "Inherited", classification: undefined }),
      row({ name: "Explicit", classification: "base" }),
      row({ name: "Jacket", classification: "worn" }),
    ];
    expect(names(filterVaultRows(rows, "base"))).toEqual(["Inherited", "Explicit"]);
  });

  it("'worn' and 'consumable' match only the literal", () => {
    const rows = [
      row({ name: "Jacket", classification: "worn" }),
      row({ name: "Bar", classification: "consumable" }),
      row({ name: "Tent", classification: undefined }),
    ];
    expect(names(filterVaultRows(rows, "worn"))).toEqual(["Jacket"]);
    expect(names(filterVaultRows(rows, "consumable"))).toEqual(["Bar"]);
  });

});

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
    expect(out.map((s) => s.label)).toEqual(["Kits", "Shelter & sleep", "Food, water & kitchen", "Other"]);
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

describe("searchVaultRows — notes and other scripts", () => {
  it("matches Chinese names and notes without unrelated results", () => {
    const rows = [row({ name: "SmallRig 电池", description: "蓝色 USB-C" }), row({ name: "炉头" })];
    expect(names(searchVaultRows(rows, "电池"))).toEqual(["SmallRig 电池"]);
    expect(names(searchVaultRows(rows, "蓝色"))).toEqual(["SmallRig 电池"]);
    expect(names(searchVaultRows(rows, "smallrig 电池"))).toEqual(["SmallRig 电池"]);
    expect(names(searchVaultRows(rows, "电"))).toEqual(["SmallRig 电池"]);
    expect(searchVaultRows(rows, "熊罐")).toEqual([]);
  });

  it("ranks the gear itself above a note that mentions it, and keeps the ranker's order", () => {
    const rows = [
      row({ name: "Repair kit", description: "patches for the Duplex floor" }),
      row({ name: "Stake bag", description: "Duplex stakes" }),
      row({ brand: "Zpacks", name: "Duplex", timesSeen: 1 }),
      row({ brand: "Zpacks", name: "Duplex", variant: "Zip", timesSeen: 40 }),
    ];
    expect(names(searchVaultRows(rows, "duplex"))).toEqual(["Duplex", "Duplex", "Repair kit", "Stake bag"]);
    // the ranker's tie-break (timesSeen) still decides between the two Duplexes
    expect(searchVaultRows(rows, "duplex").slice(0, 2).map((r) => r.variant)).toEqual(["Zip", undefined]);
    // a typo still finds the gear; a note is only ever a literal match
    expect(names(searchVaultRows(rows, "dupelx"))).toEqual(["Duplex", "Duplex"]);
  });

  it("every word of the query has to land somewhere on the row", () => {
    const rows = [row({ name: "Repair kit", description: "patches for the Duplex floor" }), row({ name: "Stake bag", description: "Duplex stakes" })];
    expect(names(searchVaultRows(rows, "duplex patches"))).toEqual(["Repair kit"]);
  });

  it("a single ideograph is a whole query: ranked like a word, then its notes", () => {
    const rows = [row({ name: "炉头" }), row({ name: "SmallRig 电池", description: "配炉头用" }), row({ name: "眼罩" })];
    expect(names(searchVaultRows(rows, "炉"))).toEqual(["炉头", "SmallRig 电池"]);
  });

  it("a single character is a prefix question about the gear, not its notes", () => {
    const rows = [row({ name: "Tent", description: "a note" }), row({ name: "Pump", description: "tiny" })];
    expect(names(searchVaultRows(rows, "t"))).toEqual(["Tent"]);
  });
});
