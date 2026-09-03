// /gear's view pipeline — filter → search → sort → group.
//
// Plain node, no Nuxt and no database: that is the whole reason shared/vaultView.ts
// exists as its own module. The rules worth pinning here are the ones that are
// invisible until they're wrong — a limit that silently truncates, a filter that
// matches almost nothing, a heading that vanishes.

import { describe, expect, it } from "vitest";
import type { VaultEntry, VaultFolder } from "../shared/vault";
import {
  filterVaultRows,
  groupVaultRows,
  searchVaultRows,
  sortVaultRows,
} from "../shared/vaultView";

let nextId = 1;
const row = (over: Partial<VaultEntry> = {}): VaultEntry => ({
  id: nextId++,
  normKey: `k${nextId}`,
  name: "Duplex",
  weightMg: 500_000,
  timesSeen: 1,
  lastUsedAt: "2026-08-01T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const folder = (id: number, name: string): VaultFolder => ({ id, name });

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

  it("'unfiled' matches a missing folderId", () => {
    const rows = [row({ name: "Loose" }), row({ name: "Filed", folderId: 3 })];
    expect(names(filterVaultRows(rows, "unfiled"))).toEqual(["Loose"]);
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

describe("groupVaultRows — the folders view", () => {
  const shelter = folder(1, "Shelter");
  const cook = folder(2, "Cook");

  it("puts unfiled last, whatever the folder order", () => {
    const rows = [
      row({ name: "Loose" }),
      row({ name: "Tent", folderId: 1 }),
      row({ name: "Pot", folderId: 2 }),
    ];
    const out = groupVaultRows(rows, [shelter, cook], { keepEmpty: true });
    expect(out.map((s) => s.folder?.name ?? "unfiled")).toEqual(["Shelter", "Cook", "unfiled"]);
  });

  it("keeps an empty folder when nothing is narrowed — it's a heading you made", () => {
    const out = groupVaultRows([row({ name: "Tent", folderId: 1 })], [shelter, cook], {
      keepEmpty: true,
    });
    expect(out.map((s) => s.folder?.name)).toEqual(["Shelter", "Cook"]);
    expect(out[1]!.entries).toEqual([]);
  });

  it("drops an empty folder under a filter, so the matches aren't buried", () => {
    const out = groupVaultRows([row({ name: "Tent", folderId: 1 })], [shelter, cook], {
      keepEmpty: false,
    });
    expect(out.map((s) => s.folder?.name)).toEqual(["Shelter"]);
  });

  it("omits the unfiled section entirely when nothing is unfiled", () => {
    const out = groupVaultRows([row({ folderId: 1 })], [shelter], { keepEmpty: true });
    expect(out).toHaveLength(1);
  });

  it("states each folder's count and weight", () => {
    const rows = [
      row({ name: "Tent", folderId: 1, weightMg: 500 }),
      row({ name: "Stakes", folderId: 1, weightMg: 100 }),
      row({ name: "Loose", weightMg: 7 }),
    ];
    const out = groupVaultRows(rows, [shelter], { keepEmpty: true });
    expect(out[0]).toMatchObject({ count: 2, weightMg: 600 });
    expect(out[1]).toMatchObject({ count: 1, weightMg: 7 });
  });
});

