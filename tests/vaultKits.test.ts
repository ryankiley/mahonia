// Kits in My Gear: a vault row that names a set of pieces, weighing what they weigh.
//
// What is pinned here is the arithmetic (own + live parts × qty), the rules that keep
// a kit one level deep and inside its own vault, the guards that stop a list from
// writing a kit's typed total back into its own weight (which would count every part
// twice), and the one way a container becomes gear: a group row saved as a kit.

import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { vaultItems, vaultKitParts, vaults } from "../server/db/schema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import {
  applyVaultItemOp,
  captureKit,
  captureVaultItems,
  captureVaultItemsReporting,
  vaultItemById,
  importVaultItems,
  listVaultItems,
  purgeDeletedVaults,
  removeVaultItem,
  restoreVaultItem,
  searchVaultItems,
  setKitParts,
  vaultGearAmong,
} from "../server/utils/vaultRepo";
import { captureFromList, isKitWorthy, isVaultWorthy, vaultNormKey, type VaultEntry } from "../shared/vault";
import { countedWeightMg, kitFromGroup, kitWeightMg } from "../shared/vaultKit";
import { groupVaultByKind } from "../shared/vaultView";
import { vaultToCsv, vaultToJson } from "../shared/exporters/vault";
import { parseVaultImport } from "../shared/vaultImport";
import type { Item } from "../shared/types";
import { createTestDb, type TestDb } from "./helpers/db";

let db: TestDb;
let vault = 0;

async function newVault(): Promise<number> {
  const [v] = await db.insert(vaults).values({}).returning();
  return v!.id;
}

/** Add a piece by hand, the way /gear's add row does; returns its id. */
async function piece(name: string, grams: number, vaultId = vault, owned?: number): Promise<number> {
  const res = await applyVaultItemOp(db, vaultId, { t: "add", name, weightMg: grams * 1000, owned });
  if (!res || !("item" in res)) throw new Error(`could not add ${name}`);
  return res.item.id;
}

const byId = (rows: VaultEntry[], id: number) => rows.find((r) => r.id === id)!;

/** A cook kit made on /gear out of pieces already held. */
async function cookKit() {
  const stove = await piece("PocketRocket 2", 73);
  const pot = await piece("Toaks 750", 103);
  const lighter = await piece("Mini Bic", 11, vault, 2);
  const kit = await piece("Cook kit", 0);
  const ok = await setKitParts(db, vault, kit, [{ id: stove }, { id: pot }, { id: lighter, qty: 2 }], {
    ownWeightMg: 20_000,
  });
  expect(ok).not.toBeNull();
  return { stove, pot, lighter, kit };
}

const row = (name: string, grams: number, over: Partial<Item> = {}): Item => ({
  id: `i-${name}`,
  folderId: "f1",
  name,
  unitWeightMg: grams * 1000,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

beforeEach(async () => {
  db = await createTestDb(VAULT_DDL);
  vault = await newVault();
});

// ---------------------------------------------------------------------------
// the arithmetic, without a database
// ---------------------------------------------------------------------------
describe("kitWeightMg and countedWeightMg", () => {
  const parts = [
    { id: 1, qty: 1, name: "Stove", weightMg: 73_000 },
    { id: 2, qty: 2, name: "Lighter", weightMg: 11_000 },
    { id: 3, qty: 1, name: "Pot", weightMg: 103_000, removed: true },
  ];
  it("adds its own weight and each live part times its qty, skipping put-away parts", () => {
    expect(kitWeightMg(20_000, parts)).toBe(20_000 + 73_000 + 22_000);
  });
  it("counts a kit toward a total by its own weight only", () => {
    expect(countedWeightMg({ kind: "kit", ownWeightMg: 20_000, weightMg: 115_000 })).toBe(20_000);
    expect(countedWeightMg({ weightMg: 115_000 })).toBe(115_000);
  });
  it("weighs a kit at the counts it holds: three lighters weigh three lighters", () => {
    expect(kitWeightMg(20_000, [{ id: 1, qty: 3, name: "Mini Bic", weightMg: 11_000 }])).toBe(20_000 + 33_000);
  });

  it("lists a kit first, and each of its pieces in its own kind too", () => {
    const base = { normKey: "", name: "", timesSeen: 1, lastUsedAt: "", createdAt: "" };
    const stove: VaultEntry = { ...base, id: 1, name: "Stove", commonName: "Stove", weightMg: 73_000, inKits: [2] };
    const kit: VaultEntry = {
      ...base, id: 2, name: "Cook kit", kind: "kit", ownWeightMg: 20_000, weightMg: 93_000,
      parts: [{ id: 1, qty: 1, name: "Stove", weightMg: 73_000 }],
    };
    const tent: VaultEntry = { ...base, id: 3, name: "Duplex", commonName: "Tent", weightMg: 900_000 };
    const sections = groupVaultByKind([stove, kit, tent]);
    expect(sections.map((s) => [s.key, s.entries.map((e) => e.id)])).toEqual([
      ["kits", [2]],
      ["shelter", [3]],
      ["kitchen", [1]],
    ]);
  });
});

describe("kitFromGroup — a group row as a kit", () => {
  const group = row("Cook kit", 20, { id: "g" });
  const kids = [
    row("PocketRocket 2", 73, { parentId: "g" }),
    row("Mini Bic", 11, { parentId: "g", qty: 2 }),
    row("Mini Bic", 11, { id: "i-bic2", parentId: "g" }),
    row("", 0, { id: "blank", parentId: "g" }),
    row("Elsewhere", 50, { id: "other" }),
  ];
  it("takes the parent's own weight and the children as parts, by identity, counts added", () => {
    const made = kitFromGroup(group, [group, ...kids], "Kitchen")!;
    expect(made.kit.weightMg).toBe(20_000);
    expect(made.kit.parts).toEqual([
      { normKey: vaultNormKey(undefined, "PocketRocket 2", undefined), qty: 1 },
      { normKey: vaultNormKey(undefined, "Mini Bic", undefined), qty: 3 },
    ]);
    expect(made.parts.map((p) => p.name)).toEqual(["PocketRocket 2", "Mini Bic"]);
  });
  it("is nothing without a worthy child, a name, or on water", () => {
    expect(kitFromGroup(group, [group, row("", 0, { parentId: "g" })])).toBeNull();
    expect(kitFromGroup(row("", 0, { id: "g" }), [...kids])).toBeNull();
    expect(kitFromGroup(row("Water", 0, { id: "g", classification: "consumable" }), kids)).toBeNull();
    expect(isKitWorthy(group, kids)).toBe(true);
    // the automatic rule is unchanged: a group is never gear to a capture
    expect(isVaultWorthy(group, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// a kit's weight is its parts'
// ---------------------------------------------------------------------------
describe("a kit's weight is its parts'", () => {
  it("derives the total from its parts, in order, and a piece says which kits it is in", async () => {
    const k = await cookKit();
    const rows = await listVaultItems(db, vault);
    const kit = byId(rows, k.kit);
    expect(kit.kind).toBe("kit");
    expect(kit.ownWeightMg).toBe(20_000);
    expect(kit.weightMg).toBe(20_000 + 73_000 + 103_000 + 2 * 11_000);
    expect(kit.parts!.map((p) => p.id)).toEqual([k.stove, k.pot, k.lighter]);
    expect(kit.parts![2]).toMatchObject({ name: "Mini Bic", qty: 2, weightMg: 11_000 });
    expect(byId(rows, k.lighter).inKits).toEqual([k.kit]);
    expect(byId(rows, k.lighter).kind).toBeUndefined();
  });

  it("follows a re-weighed part the next time it is read", async () => {
    const k = await cookKit();
    await applyVaultItemOp(db, vault, { t: "edit", id: k.pot, patch: { weightMg: 110_000 } });
    expect((await vaultItemById(db, vault, k.kit))!.weightMg).toBe(20_000 + 73_000 + 110_000 + 22_000);
  });

  it("stops counting a put-away part, keeps it listed, and counts it again when it is back", async () => {
    const k = await cookKit();
    await removeVaultItem(db, vault, k.pot);
    const kit = byId(await listVaultItems(db, vault), k.kit);
    expect(kit.weightMg).toBe(20_000 + 73_000 + 22_000);
    expect(kit.parts!.find((p) => p.id === k.pot)).toMatchObject({ removed: true });
    await restoreVaultItem(db, vault, k.pot);
    expect((await vaultItemById(db, vault, k.kit))!.weightMg).toBe(218_000);
  });

  it("lets one piece belong to several kits, and a put-away kit stops claiming it", async () => {
    const lighter = await piece("Mini Bic", 11);
    const stove = await piece("Stove", 73);
    const tinder = await piece("Tinder", 5);
    const cook = await piece("Cook kit", 0);
    const fire = await piece("Fire kit", 0);
    expect(await setKitParts(db, vault, cook, [{ id: stove }, { id: lighter }], { ownWeightMg: 0 })).not.toBeNull();
    expect(await setKitParts(db, vault, fire, [{ id: lighter }, { id: tinder }], { ownWeightMg: 0 })).not.toBeNull();
    let rows = await listVaultItems(db, vault);
    expect(byId(rows, lighter).inKits).toEqual([cook, fire].sort((a, b) => a - b));
    await removeVaultItem(db, vault, fire);
    rows = await listVaultItems(db, vault);
    expect(byId(rows, lighter).inKits).toEqual([cook]);
    expect((await vaultItemById(db, vault, fire))!.weightMg).toBe(16_000);
  });

  it("keeps kits out of the autocomplete, and carries kit fields through an edit's answer", async () => {
    const k = await cookKit();
    expect((await searchVaultItems(db, vault, "cook kit")).map((r) => r.id)).not.toContain(k.kit);
    expect((await searchVaultItems(db, vault, "pocketrocket")).map((r) => r.id)).toContain(k.stove);
    const renamed = await applyVaultItemOp(db, vault, { t: "edit", id: k.kit, patch: { name: "Kitchen kit" } });
    expect(renamed && "item" in renamed && renamed.item).toMatchObject({ name: "Kitchen kit", kind: "kit", weightMg: 218_000 });
  });
});

// ---------------------------------------------------------------------------
// the rules a kit keeps
// ---------------------------------------------------------------------------
describe("the rules a kit keeps", () => {
  it("refuses a part from another vault, a kit as a part, itself, and no parts — writing nothing", async () => {
    const other = await newVault();
    const theirs = await piece("Their stove", 80, other);
    const mine = await piece("My pot", 100);
    const kit = await piece("Cook kit", 0);
    const second = await piece("Second kit", 0);
    expect(await setKitParts(db, vault, kit, [{ id: mine }, { id: theirs }], { ownWeightMg: 0 })).toBeNull();
    expect(await setKitParts(db, vault, kit, [{ id: kit }], { ownWeightMg: 0 })).toBeNull();
    expect(await setKitParts(db, vault, kit, [], { ownWeightMg: 0 })).toBeNull();
    expect((await vaultItemById(db, vault, kit))!.kind).toBeUndefined();

    expect(await setKitParts(db, vault, kit, [{ id: mine }], { ownWeightMg: 0 })).not.toBeNull();
    // one level deep: a kit can't be a part, and a part can't become a kit
    expect(await setKitParts(db, vault, second, [{ id: kit }], { ownWeightMg: 0 })).toBeNull();
    expect(await setKitParts(db, vault, mine, [{ id: second }], { ownWeightMg: 0 })).toBeNull();
    // another vault can't reach it
    expect(await setKitParts(db, other, kit, [{ id: theirs }], { ownWeightMg: 0 })).toBeNull();
  });

  it("holds no more of a piece than you own: a count past it is held to it, and owning fewer brings kits down", async () => {
    const bottle = await piece("Smartwater", 35);
    const kit = await piece("Water kit", 0);
    expect(await setKitParts(db, vault, kit, [{ id: bottle, qty: 3 }], { ownWeightMg: 0 })).not.toBeNull();
    expect((await vaultItemById(db, vault, kit))!.parts!.map((p) => p.qty)).toEqual([1]);
    // own three, and the kit can hold three
    await applyVaultItemOp(db, vault, { t: "edit", id: bottle, patch: { owned: 3 } });
    await setKitParts(db, vault, kit, [{ id: bottle, qty: 3 }], { ownWeightMg: 0 });
    expect((await vaultItemById(db, vault, kit))!).toMatchObject({ weightMg: 105_000 });
    // own two again, and every kit holding three holds two
    await applyVaultItemOp(db, vault, { t: "edit", id: bottle, patch: { owned: 2 } });
    expect((await vaultItemById(db, vault, kit))!).toMatchObject({ weightMg: 70_000, parts: [expect.objectContaining({ qty: 2 })] });
  });

  it("the kit op replaces the parts, and an empty parts list makes it a piece at the total it showed", async () => {
    const k = await cookKit();
    const spoon = await piece("Spoon", 15);
    const replaced = await applyVaultItemOp(db, vault, { t: "kit", id: k.kit, parts: [{ id: k.pot }, { id: spoon }], ownWeightMg: 0 });
    expect(replaced && "item" in replaced && replaced.item).toMatchObject({ kind: "kit", weightMg: 118_000 });
    expect((await vaultItemById(db, vault, k.stove))!.inKits).toBeUndefined();
    const cleared = await applyVaultItemOp(db, vault, { t: "kit", id: k.kit, parts: [] });
    expect(cleared && "item" in cleared && cleared.item).toMatchObject({ weightMg: 118_000 });
    expect((cleared as { item: VaultEntry }).item.kind).toBeUndefined();
    expect(await db.select().from(vaultKitParts)).toEqual([]);
  });

  it("refuses a weight edit on a kit but takes a rename", async () => {
    const k = await cookKit();
    expect(await applyVaultItemOp(db, vault, { t: "edit", id: k.kit, patch: { weightMg: 218_000 } })).toBeNull();
    const [r] = await db.select().from(vaultItems).where(eq(vaultItems.id, k.kit));
    expect(Number(r!.weightMg)).toBe(20_000);
  });

  it("re-adding a put-away kit by name brings it back without the typed weight", async () => {
    const k = await cookKit();
    await removeVaultItem(db, vault, k.kit);
    const res = await applyVaultItemOp(db, vault, { t: "add", name: "Cook kit", weightMg: 999_000 });
    expect(res && "item" in res && res.item).toMatchObject({ kind: "kit", ownWeightMg: 20_000, weightMg: 218_000 });
  });

  it("purges a vault's kit links with the vault, and only that vault's", async () => {
    await cookKit();
    await db.update(vaults).set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(vaults.id, vault));
    const keep = await newVault();
    const pot = await piece("Pot", 100, keep);
    const cook = await piece("Cook kit", 0, keep);
    await setKitParts(db, keep, cook, [{ id: pot }], { ownWeightMg: 0 });
    await purgeDeletedVaults(db, { graceDays: 30 });
    expect(await db.select().from(vaultKitParts)).toEqual([expect.objectContaining({ kitId: cook, partId: pot })]);
  });
});

// ---------------------------------------------------------------------------
// capture leaves a kit's weight alone
// ---------------------------------------------------------------------------
describe("capture leaves a kit's weight alone", () => {
  it("an old list holding the kit as one flat row writes no weight into it, but usage moves", async () => {
    const k = await cookKit();
    const before = (await vaultItemById(db, vault, k.kit))!;
    await captureVaultItems(db, vault, captureFromList([row("Cook kit", 218), row("Toaks 750", 103)]));
    const after = (await vaultItemById(db, vault, k.kit))!;
    expect(after.ownWeightMg).toBe(20_000);
    expect(after.weightMg).toBe(218_000);
    expect(after.timesSeen).toBe(before.timesSeen + 1);
    expect(after.parts).toHaveLength(3);
  });

  it("even a deliberate save can't, and the kit answers as one with nothing to push", async () => {
    const k = await cookKit();
    const key = vaultNormKey(undefined, "Cook kit", undefined);
    const { keys } = await captureVaultItemsReporting(db, vault, captureFromList([row("Cook kit", 500)]), { overwriteWeight: true });
    expect((await vaultItemById(db, vault, k.kit))!.ownWeightMg).toBe(20_000);
    expect(keys).toEqual([[key, null, "kit"]]);
    expect(await vaultGearAmong(db, vault, [key])).toEqual([[key, null, "kit"]]);
  });

  it("a list holding the kit as a group captures only its pieces; the automatic path makes no kit", async () => {
    const items = [row("Repair kit", 0, { id: "g" }), row("Tenacious Tape", 12, { parentId: "g" }), row("Needle", 1, { parentId: "g" })];
    await captureVaultItems(db, vault, captureFromList(items));
    const rows = await listVaultItems(db, vault);
    expect(rows.map((r) => r.name).sort()).toEqual(["Needle", "Tenacious Tape"]);
    expect(rows.some((r) => r.kind === "kit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// a group row, saved as a kit
// ---------------------------------------------------------------------------
describe("captureKit — the group row's own save", () => {
  const list = [
    row("Cook kit", 20, { id: "g", folderId: "f1" }),
    row("PocketRocket 2", 73, { parentId: "g" }),
    row("Toaks 750", 103, { parentId: "g" }),
    row("Mini Bic", 11, { parentId: "g", qty: 2 }),
  ];
  const made = () => kitFromGroup(list[0]!, list, "Kitchen")!;

  it("lands the parts as pieces and the group as a kit of them, with the group's own weight", async () => {
    const res = await captureKit(db, vault, made().kit, made().parts, { overwriteWeight: true });
    expect(res.kit).toBe("saved");
    const rows = await listVaultItems(db, vault);
    const kit = rows.find((r) => r.kind === "kit")!;
    expect(kit).toMatchObject({ name: "Cook kit", ownWeightMg: 20_000, weightMg: 20_000 + 73_000 + 103_000 + 22_000 });
    expect(kit.parts!.map((p) => [p.name, p.qty])).toEqual([["PocketRocket 2", 1], ["Toaks 750", 1], ["Mini Bic", 2]]);
    // the group carried two lighters, so you own two: a kit never holds more than that
    expect(rows.find((r) => r.name === "Mini Bic")!.owned).toBe(2);
    // the answer names every row that landed, the kit as a kit
    const key = vaultNormKey(undefined, "Cook kit", undefined);
    expect(res.keys).toContainEqual([key, null, "kit"]);
    expect(res.keys).toHaveLength(4);
  });

  it("links a piece once when two of the group's children land on the same row, holding both counts", async () => {
    // the zero-width space folds to a gap on the client and is tidied away here, so the
    // two refs differ as sent and meet once the server has keyed them
    const group = [row("Shelter", 0, { id: "g" }), row("Duplex", 539, { parentId: "g" }), row("Dup\u200blex", 539, { parentId: "g" })];
    const m = kitFromGroup(group[0]!, group)!;
    expect(new Set(m.kit.parts.map((p) => p.normKey)).size).toBe(2);
    expect((await captureKit(db, vault, m.kit, m.parts)).kit).toBe("saved");
    const kit = (await listVaultItems(db, vault)).find((r) => r.kind === "kit")!;
    expect(kit.parts!.map((p) => [p.name, p.qty])).toEqual([["Duplex", 2]]);
  });

  it("converts a piece of the same name in place — its typed total gives way to the parts", async () => {
    const old = await piece("Cook kit", 218);
    const res = await captureKit(db, vault, made().kit, made().parts, { overwriteWeight: true });
    expect(res.kit).toBe("saved");
    const kit = (await vaultItemById(db, vault, old))!;
    expect(kit).toMatchObject({ kind: "kit", ownWeightMg: 20_000, weightMg: 218_000 });
    expect(kit.pinned ?? []).not.toContain("weight");
  });

  it("pressing again replaces the parts with the group as it is now", async () => {
    await captureKit(db, vault, made().kit, made().parts);
    const smaller = [list[0]!, row("Toaks 750", 103, { parentId: "g" })];
    const again = kitFromGroup(smaller[0]!, smaller)!;
    expect((await captureKit(db, vault, again.kit, again.parts)).kit).toBe("saved");
    const kit = (await listVaultItems(db, vault)).find((r) => r.kind === "kit")!;
    expect(kit.parts!.map((p) => p.name)).toEqual(["Toaks 750"]);
  });

  it("refuses to make a kit of a piece that is already some kit's part, writing nothing", async () => {
    const k = await cookKit(); // holds "Mini Bic" as a part
    const group = [row("Mini Bic", 0, { id: "g" }), row("Flint", 5, { parentId: "g" })];
    const m = kitFromGroup(group[0]!, group)!;
    const res = await captureKit(db, vault, m.kit, m.parts);
    expect(res.kit).toBe("nested");
    expect((await vaultItemById(db, vault, k.lighter))!.kind).toBeUndefined();
    // the part still landed as a piece
    expect((await listVaultItems(db, vault)).some((r) => r.name === "Flint")).toBe(true);
  });

  it("a put-away kit doesn't keep its piece from becoming a kit, and lets go of it", async () => {
    const k = await cookKit(); // holds "Mini Bic" as a part
    await removeVaultItem(db, vault, k.kit);
    const group = [row("Mini Bic", 0, { id: "g" }), row("Flint", 5, { parentId: "g" })];
    const m = kitFromGroup(group[0]!, group)!;
    expect((await captureKit(db, vault, m.kit, m.parts)).kit).toBe("saved");
    expect((await vaultItemById(db, vault, k.lighter))!.kind).toBe("kit");
    // brought back, the cook kit can't hold a kit: one level deep
    expect((await vaultItemById(db, vault, k.kit))!.parts!.map((p) => p.name)).not.toContain("Mini Bic");
  });

  it("a put-away kit is written and stays put away, reporting so", async () => {
    const k = await cookKit();
    await removeVaultItem(db, vault, k.kit);
    const res = await captureKit(db, vault, made().kit, made().parts);
    expect(res.kit).toBe("removed");
    expect(res.keys.some((key) => key[2] === "kit")).toBe(false);
    expect((await vaultItemById(db, vault, k.kit))!.parts).toHaveLength(3);
  });

  it("is refused when no named part can be a part — a kit of kits is not a kit", async () => {
    const k = await cookKit();
    const group = [row("Everything", 0, { id: "g" }), row("Cook kit", 218, { parentId: "g" })];
    const m = kitFromGroup(group[0]!, group)!;
    expect((await captureKit(db, vault, m.kit, m.parts)).kit).toBe("refused");
    expect((await listVaultItems(db, vault)).some((r) => r.name === "Everything")).toBe(false);
    expect((await vaultItemById(db, vault, k.kit))!.kind).toBe("kit");
  });

  it("refused over a piece of the same name, leaves that piece as it was: its weight, its pin, its uses", async () => {
    await cookKit();
    const everything = await piece("Everything", 900); // typed in, so its weight is pinned
    const before = (await vaultItemById(db, vault, everything))!;
    const group = [row("Everything", 0, { id: "g" }), row("Cook kit", 218, { parentId: "g" })];
    const m = kitFromGroup(group[0]!, group)!;
    expect((await captureKit(db, vault, m.kit, m.parts, { overwriteWeight: true })).kit).toBe("refused");
    const after = (await vaultItemById(db, vault, everything))!;
    expect(after).toMatchObject({ weightMg: 900_000, timesSeen: before.timesSeen });
    expect(after.kind).toBeUndefined();
    expect(after.pinned).toContain("weight");
  });

  it("saved over a piece of the same name, fills in what a capture would: calories, price, catalog link", async () => {
    await captureVaultItems(db, vault, captureFromList([row("Breakfast kit", 300)]));
    const group = [
      row("Breakfast kit", 20, { id: "g", kcal: 900, priceCents: 2_500, currency: "USD", catalogItemId: 7 }),
      row("Oatmeal", 100, { parentId: "g" }),
      row("Coffee", 30, { parentId: "g" }),
    ];
    const m = kitFromGroup(group[0]!, group)!;
    expect((await captureKit(db, vault, m.kit, m.parts)).kit).toBe("saved");
    const kit = (await listVaultItems(db, vault)).find((r) => r.name === "Breakfast kit")!;
    expect(kit).toMatchObject({ kind: "kit", ownWeightMg: 20_000, kcal: 900, priceCents: 2_500, currency: "USD", catalogItemId: 7 });
  });
});

// ---------------------------------------------------------------------------
// out and back
// ---------------------------------------------------------------------------
describe("a kit in a file", () => {
  it("exports its own weight to the CSV, so the column sums once", async () => {
    await cookKit();
    const items = await listVaultItems(db, vault);
    const csv = vaultToCsv({ items }, "g");
    const kitLine = csv.split("\n").find((l) => l.includes("Cook kit"))!;
    expect(kitLine.split(",")[4]).toBe("20");
  });

  it("comes back from our own JSON as a kit, parts linked, into an empty vault", async () => {
    await cookKit();
    const json = vaultToJson({ items: await listVaultItems(db, vault) });
    const other = await newVault();
    const parsed = parseVaultImport(json);
    expect(parsed.from).toBe("json");
    const { added } = await importVaultItems(db, other, parsed.rows);
    expect(added).toBe(4);
    const kit = (await listVaultItems(db, other)).find((r) => r.kind === "kit")!;
    expect(kit).toMatchObject({ name: "Cook kit", ownWeightMg: 20_000, weightMg: 218_000 });
    expect(kit.parts!.map((p) => [p.name, p.qty])).toEqual([["PocketRocket 2", 1], ["Toaks 750", 1], ["Mini Bic", 2]]);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from vault_kit_parts`)).rows as { n: number }[];
    expect(n).toBe(6);
  });

  it("comes back as a piece at the file's total when none of its parts can be found", async () => {
    await cookKit();
    const kitOnly = (await listVaultItems(db, vault)).filter((r) => r.kind === "kit");
    const other = await newVault();
    expect((await importVaultItems(db, other, parseVaultImport(vaultToJson({ items: kitOnly })).rows)).added).toBe(1);
    const [back] = await listVaultItems(db, other);
    expect(back).toMatchObject({ name: "Cook kit", weightMg: 218_000 });
    expect(back!.kind).toBeUndefined();
  });
});
