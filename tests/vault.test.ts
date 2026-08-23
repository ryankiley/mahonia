import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultFolders, vaultItems, vaults } from "../server/db/schema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { UNIT_WEIGHT_MAX_MG } from "../shared/ops";
import {
  VAULT_FOLDERS_MAX,
  VAULT_ITEMS_MAX,
  applyVaultFolderOp,
  applyVaultItemOp,
  captureVaultItems,
  listRemovedVaultItems,
  listVaultFolders,
  listVaultItems,
  purgeDeletedVaults,
  reapAbandonedVaults,
  removeVaultItem,
  restoreVaultItem,
  searchVaultItems,
} from "../server/utils/vaultRepo";
import {
  captureFingerprint,
  captureFromList,
  isVaultWorthy,
  vaultNormKey,
} from "../shared/vault";
import { rankVaultRows } from "../shared/vaultSearch";
import type { Item, MyListEntry } from "../shared/types";
import { createTestDb } from "./helpers/db";

type DB = ReturnType<typeof drizzle>;
async function freshDb(): Promise<DB> {
  return createTestDb(VAULT_DDL);
}

const item = (over: Partial<Item> = {}): Item => ({
  id: "i1",
  folderId: "f1",
  name: "Duplex",
  brand: "Zpacks",
  unitWeightMg: 539_000,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------
describe("vaultNormKey — what counts as the same piece of gear", () => {
  it("folds case, spacing and punctuation to one key", () => {
    const a = vaultNormKey("Zpacks", "Duplex", null);
    expect(vaultNormKey("ZPACKS", "  duplex  ", null)).toBe(a);
    expect(vaultNormKey("zpacks!", "Duplex.", undefined)).toBe(a);
  });

  it("folds diacritics, so an accented brand matches its plain spelling", () => {
    expect(vaultNormKey("Fjällräven", "Kajka", null)).toBe(vaultNormKey("Fjallraven", "Kajka", null));
  });

  it("keeps variants distinct — a different size is different gear", () => {
    expect(vaultNormKey("Durston", "X-Mid", "2P")).not.toBe(vaultNormKey("Durston", "X-Mid", "1P"));
  });

  it("returns '' for a nameless row, so it can never be stored", () => {
    expect(vaultNormKey("Zpacks", "", null)).toBe("");
    expect(vaultNormKey("Zpacks", "   ", null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// what gets captured
// ---------------------------------------------------------------------------
describe("isVaultWorthy — which list rows are gear", () => {
  it("takes a named, weighed row", () => {
    expect(isVaultWorthy(item(), false)).toBe(true);
  });

  it("takes a catalog pick that has no weight yet", () => {
    expect(isVaultWorthy(item({ unitWeightMg: 0, catalogItemId: 42 }), false)).toBe(true);
  });

  it("skips a blank row, an unweighed free-text row, and a group", () => {
    expect(isVaultWorthy(item({ name: "   " }), false)).toBe(false);
    expect(isVaultWorthy(item({ unitWeightMg: 0, catalogItemId: undefined }), false)).toBe(false);
    // a container ("Cook kit") is not gear — its children are captured instead
    expect(isVaultWorthy(item({ name: "Cook kit", unitWeightMg: 0 }), true)).toBe(false);
  });

  it("skips water, which is derived from a volume rather than owned", () => {
    expect(isVaultWorthy(item({ name: "Water", classification: "consumable" }), false)).toBe(false);
  });
});

describe("captureFromList", () => {
  it("dedups within one list, last occurrence winning", () => {
    const caps = captureFromList([
      item({ id: "a", unitWeightMg: 500_000 }),
      item({ id: "b", unitWeightMg: 539_000 }),
    ]);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.weightMg).toBe(539_000);
  });

  it("captures children but not the group that holds them", () => {
    const caps = captureFromList([
      item({ id: "g", name: "Cook kit", unitWeightMg: 0, brand: undefined }),
      item({ id: "c", parentId: "g", name: "Pocket Rocket", brand: "MSR", unitWeightMg: 73_000 }),
    ]);
    expect(caps.map((c) => c.name)).toEqual(["Pocket Rocket"]);
  });

  it("drops the fields that describe the LIST rather than the gear", () => {
    const caps = captureFromList([item({ qty: 3, packed: true, wornQty: 1, sortOrder: 7 })]);
    expect(caps[0]).not.toHaveProperty("qty");
    expect(caps[0]).not.toHaveProperty("packed");
    expect(caps[0]).not.toHaveProperty("sortOrder");
  });

  it("carries the calories entered for a food row", () => {
    const caps = captureFromList([item({ classification: "consumable", kcal: 250 })]);
    expect(caps[0]!.kcal).toBe(250);
    // never-entered stays absent — zero would be a claim (see Item.kcal)
    expect(captureFromList([item()])[0]!.kcal).toBeUndefined();
  });

  it("carries the note, the price and the picture the row arrived with", () => {
    // the three the projection used to drop on the floor
    const caps = captureFromList([
      item({
        description: "Seam-sealed 2024",
        priceCents: 69_900,
        currency: "USD",
        imageUrl: "https://example.com/tent.jpg",
      }),
    ]);
    expect(caps[0]!.description).toBe("Seam-sealed 2024");
    expect(caps[0]!.priceCents).toBe(69_900);
    expect(caps[0]!.currency).toBe("USD");
    expect(caps[0]!.imageUrl).toBe("https://example.com/tent.jpg");
  });

  it("drops a currency with no amount under it", () => {
    // a unit with nothing to measure — and it would render as one on the row
    const caps = captureFromList([item({ currency: "USD" })]);
    expect(caps[0]!.currency).toBeUndefined();
    expect(caps[0]!.priceCents).toBeUndefined();
  });
});

describe("captureFingerprint — the gate that stops needless writes", () => {
  it("is stable across row ORDER (a drag changes nothing about the gear)", () => {
    const a = item({ id: "a", name: "Duplex" });
    const b = item({ id: "b", name: "Neoair", brand: "Therm-a-Rest" });
    expect(captureFingerprint(captureFromList([a, b]))).toBe(
      captureFingerprint(captureFromList([b, a])),
    );
  });

  it("changes when a weight changes", () => {
    const before = captureFingerprint(captureFromList([item()]));
    const after = captureFingerprint(captureFromList([item({ unitWeightMg: 545_000 })]));
    expect(after).not.toBe(before);
  });

  it("changes when only the spelling changes — the vault takes the incoming spelling", () => {
    const before = captureFingerprint(captureFromList([item({ name: "duplex" })]));
    const after = captureFingerprint(captureFromList([item({ name: "Duplex" })]));
    expect(after).not.toBe(before);
  });

  it("changes when the product URL changes", () => {
    const before = captureFingerprint(captureFromList([item()]));
    const after = captureFingerprint(
      captureFromList([item({ productUrl: "https://zpacks.com/duplex" })]),
    );
    expect(after).not.toBe(before);
  });

  it("changes when the calories change — a re-counted bar is worth re-sending", () => {
    const before = captureFingerprint(captureFromList([item({ kcal: 250 })]));
    const after = captureFingerprint(captureFromList([item({ kcal: 400 })]));
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// ranking
// ---------------------------------------------------------------------------
describe("rankVaultRows", () => {
  const rows = [
    { id: 1, brand: "Zpacks", name: "Duplex", variant: undefined, commonName: "Tent", timesSeen: 1 },
    { id: 2, brand: "Durston", name: "X-Mid", variant: "2P", commonName: "Tent", timesSeen: 9 },
  ];

  it("ignores a one-character query (too noisy for trigrams)", () => {
    expect(rankVaultRows(rows, "d")).toEqual([]);
  });

  it("ranks a prefix match above a merely frequent one", () => {
    expect(rankVaultRows(rows, "duplex")[0]!.id).toBe(1);
  });

  it("matches on the variant too", () => {
    expect(rankVaultRows(rows, "x-mid 2p")[0]!.id).toBe(2);
  });

  it("finds gear by its VAULT TYPE, not just its product name", () => {
    // "stove" has to find your PocketRocket exactly as it finds the catalog's —
    // commonName is the vault's analogue of catalog_items.search_terms, and
    // without it your own gear is harder to search than a stranger's
    const mine = [
      { id: 3, brand: "MSR", name: "PocketRocket 2", variant: undefined, commonName: "Stove", timesSeen: 1 },
    ];
    expect(rankVaultRows(mine, "stove").map((r) => r.id)).toEqual([3]);
  });

  it("still ranks a name match above a gear-type match", () => {
    // typing the product's name is a stronger signal than typing its category,
    // which is why commonName is excluded from the TIER target
    const mixed = [
      { id: 4, brand: null, name: "Alcohol stove", variant: undefined, commonName: undefined, timesSeen: 1 },
      { id: 5, brand: "MSR", name: "PocketRocket 2", variant: undefined, commonName: "Stove", timesSeen: 50 },
    ];
    expect(rankVaultRows(mixed, "stove")[0]!.id).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
describe("vault capture — the upsert's merge rules", () => {
  let db: DB;
  const VAULT = 1;
  beforeEach(async () => {
    db = await freshDb();
  });

  const cap = (over: Record<string, unknown> = {}) => ({
    normKey: vaultNormKey("Zpacks", "Duplex", null),
    brand: "Zpacks",
    name: "Duplex",
    weightMg: 539_000,
    ...over,
  }) as any;

  it("inserts once and updates in place on the second capture", async () => {
    await captureVaultItems(db as any, VAULT, [cap()]);
    await captureVaultItems(db as any, VAULT, [cap()]);
    const rows = await listVaultItems(db as any, VAULT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.timesSeen).toBe(2);
  });

  it("takes the newer weight — your latest measurement is your truth", async () => {
    await captureVaultItems(db as any, VAULT, [cap()]);
    await captureVaultItems(db as any, VAULT, [cap({ weightMg: 545_000 })]);
    expect((await listVaultItems(db as any, VAULT))[0]!.weightMg).toBe(545_000);
  });

  it("never lets a zero weight erase a real one", async () => {
    await captureVaultItems(db as any, VAULT, [cap()]);
    await captureVaultItems(db as any, VAULT, [cap({ weightMg: 0 })]);
    expect((await listVaultItems(db as any, VAULT))[0]!.weightMg).toBe(539_000);
  });

  it("accumulates optional fields instead of blanking them", async () => {
    await captureVaultItems(db as any, VAULT, [cap({ commonName: "tent", catalogItemId: 7 })]);
    await captureVaultItems(db as any, VAULT, [cap()]); // carries neither field
    const row = (await listVaultItems(db as any, VAULT))[0]!;
    expect(row.commonName).toBe("tent");
    expect(row.catalogItemId).toBe(7);
  });

  it("remembers calories, keeps them through a capture that has none, takes a re-count", async () => {
    await captureVaultItems(db as any, VAULT, [cap({ kcal: 250 })]);
    await captureVaultItems(db as any, VAULT, [cap()]); // carries no kcal → keeps 250
    expect((await listVaultItems(db as any, VAULT))[0]!.kcal).toBe(250);
    await captureVaultItems(db as any, VAULT, [cap({ kcal: 400 })]);
    expect((await listVaultItems(db as any, VAULT))[0]!.kcal).toBe(400);
  });

  it("types and bounds a direct POST's kcal like the editor would", async () => {
    // a string is dropped, not coerced — the editor could never have sent it
    await captureVaultItems(db as any, VAULT, [cap({ kcal: "9000" })]);
    expect((await listVaultItems(db as any, VAULT))[0]!.kcal).toBeUndefined();
    // an absurd number lands at the reducer's own ceiling
    await captureVaultItems(db as any, VAULT, [cap({ kcal: 99_000_000 })]);
    expect((await listVaultItems(db as any, VAULT))[0]!.kcal).toBe(1_000_000);
  });

  it("re-derives the identity, so a forged normKey can't collide two items", async () => {
    await captureVaultItems(db as any, VAULT, [
      cap({ normKey: "not-the-real-key", name: "Duplex" }),
      cap({ normKey: "not-the-real-key", name: "Neoair", brand: "Therm-a-Rest" }),
    ]);
    // both survive as separate rows despite claiming the same key
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(2);
  });

  it("keeps each user's gear to themselves", async () => {
    await captureVaultItems(db as any, 1, [cap()]);
    await captureVaultItems(db as any, 2, [cap({ weightMg: 100_000 })]);
    expect((await listVaultItems(db as any, 1))[0]!.weightMg).toBe(539_000);
    expect((await listVaultItems(db as any, 2))[0]!.weightMg).toBe(100_000);
  });

  it("caps and types a direct POST's fields — an oversized folder name can't error the capture", async () => {
    await captureVaultItems(db as any, VAULT, [
      cap({ brand: "B".repeat(500), folder: "F".repeat(5_000), productUrl: 123 }),
    ]);
    const row = (await listVaultItems(db as any, VAULT))[0]!;
    expect(row.brand!.length).toBe(120);
    expect(row.productUrl).toBeUndefined();
    const folders = await listVaultFolders(db as any, VAULT);
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name.length).toBe(120);
    expect(row.folderId).toBe(folders[0]!.id);
  });

  it("drops rows that don't normalize (no name)", async () => {
    const n = await captureVaultItems(db as any, VAULT, [cap({ name: "  " })]);
    expect(n).toBe(0);
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(0);
  });
});

describe("vault removal — the tombstone", () => {
  let db: DB;
  const VAULT = 1;
  const cap = {
    normKey: vaultNormKey("Zpacks", "Duplex", null),
    brand: "Zpacks",
    name: "Duplex",
    weightMg: 539_000,
  } as any;

  beforeEach(async () => {
    db = await freshDb();
    await captureVaultItems(db as any, VAULT, [cap]);
  });

  it("hides the row from the vault and from search", async () => {
    const id = (await listVaultItems(db as any, VAULT))[0]!.id;
    expect(await removeVaultItem(db as any, VAULT, id)).toBe(true);
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(0);
    expect(await searchVaultItems(db as any, VAULT, "duplex")).toHaveLength(0);
  });

  it("SURVIVES a later capture — the whole point of a tombstone", async () => {
    // Capture is automatic, so a hard delete would be undone by the next list
    // that still contains the item. Removing has to mean "stop offering me this".
    const id = (await listVaultItems(db as any, VAULT))[0]!.id;
    await removeVaultItem(db as any, VAULT, id);
    await captureVaultItems(db as any, VAULT, [cap]);
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(0);
  });

  it("comes back on an explicit restore", async () => {
    const id = (await listVaultItems(db as any, VAULT))[0]!.id;
    await removeVaultItem(db as any, VAULT, id);
    expect(await restoreVaultItem(db as any, VAULT, id)).toBe(true);
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(1);
  });

  it("refuses to touch another vault's row, for remove AND restore", async () => {
    const id = (await listVaultItems(db as any, VAULT))[0]!.id;
    const OTHER = 2;
    expect(await removeVaultItem(db as any, OTHER, id)).toBe(false);
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(1);
    // and once it IS removed by its owner, a stranger can't put it back either
    await removeVaultItem(db as any, VAULT, id);
    expect(await restoreVaultItem(db as any, OTHER, id)).toBe(false);
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(0);
  });
});

describe("vault search", () => {
  let db: DB;
  const VAULT = 1;
  beforeEach(async () => {
    db = await freshDb();
    await captureVaultItems(db as any, VAULT, [
      { normKey: vaultNormKey("Zpacks", "Duplex", null), brand: "Zpacks", name: "Duplex", weightMg: 539_000 } as any,
      { normKey: vaultNormKey("Therm-a-Rest", "NeoAir XLite", null), brand: "Therm-a-Rest", name: "NeoAir XLite", weightMg: 354_000 } as any,
    ]);
  });

  it("is typo-tolerant, like the catalog's", async () => {
    const hits = await searchVaultItems(db as any, VAULT, "duplx");
    expect(hits.map((h) => h.name)).toEqual(["Duplex"]);
  });

  it("returns nothing for a one-character query", async () => {
    expect(await searchVaultItems(db as any, VAULT, "d")).toHaveLength(0);
  });

  it("never reaches into another vault", async () => {
    expect(await searchVaultItems(db as any, 2, "duplex")).toHaveLength(0);
  });
});

// The rules that make a vault fill itself organised instead of arriving as one flat
// pile — and the one that stops it being rearranged behind your back.
describe("vault folders", () => {
  let db: DB;
  const VAULT = 1;
  beforeEach(async () => {
    db = await freshDb();
  });

  const cap = (name: string, folder?: string) => ({
    normKey: vaultNormKey("Zpacks", name, null),
    brand: "Zpacks",
    name,
    weightMg: 500_000,
    ...(folder ? { folder } : {}),
  }) as any;

  it("creates a folder from the list folder a capture names, and files the gear in it", async () => {
    await captureVaultItems(db as any, VAULT, [cap("Duplex", "Shelter"), cap("Quilt", "Sleep")]);

    const folders = await listVaultFolders(db as any, VAULT);
    expect(folders.map((f) => f.name)).toEqual(["Shelter", "Sleep"]);

    const rows = await listVaultItems(db as any, VAULT);
    const byName = new Map(rows.map((r) => [r.name, r.folderId]));
    expect(byName.get("Duplex")).toBe(folders[0]!.id);
    expect(byName.get("Quilt")).toBe(folders[1]!.id);
  });

  it("reuses one folder for the same name, however many lists send it", async () => {
    await captureVaultItems(db as any, VAULT, [cap("Duplex", "Shelter")]);
    await captureVaultItems(db as any, VAULT, [cap("Quilt", "Shelter")]);
    // "Shelter" in two lists is ONE vault folder — the name is the identity
    expect(await listVaultFolders(db as any, VAULT)).toHaveLength(1);
  });

  it("FIRST filing wins — a later list can't reshuffle a vault you've arranged", async () => {
    await captureVaultItems(db as any, VAULT, [cap("Duplex", "Shelter")]);
    const shelter = (await listVaultFolders(db as any, VAULT))[0]!;

    // the same gear, captured from a list that groups it differently
    await captureVaultItems(db as any, VAULT, [cap("Duplex", "Big 3")]);

    // the new folder exists (another list really does use it) but the row stays put
    expect((await listVaultFolders(db as any, VAULT)).map((f) => f.name)).toEqual(["Shelter", "Big 3"]);
    expect((await listVaultItems(db as any, VAULT))[0]!.folderId).toBe(shelter.id);
  });

  it("a capture with no folder leaves an already-filed row where it is", async () => {
    await captureVaultItems(db as any, VAULT, [cap("Duplex", "Shelter")]);
    const shelter = (await listVaultFolders(db as any, VAULT))[0]!;
    await captureVaultItems(db as any, VAULT, [cap("Duplex")]); // ungrouped list row
    expect((await listVaultItems(db as any, VAULT))[0]!.folderId).toBe(shelter.id);
  });

  it("deleting a folder UNFILES its gear rather than taking it along", async () => {
    await captureVaultItems(db as any, VAULT, [cap("Duplex", "Shelter"), cap("Quilt", "Shelter")]);
    const shelter = (await listVaultFolders(db as any, VAULT))[0]!;

    expect(await applyVaultFolderOp(db as any, VAULT, { t: "remove", id: shelter.id })).toBe(true);

    // a folder is a heading, not a container — losing gear because you tidied one
    // would be indefensible
    const rows = await listVaultItems(db as any, VAULT);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.folderId === undefined)).toBe(true);
    expect(await listVaultFolders(db as any, VAULT)).toHaveLength(0);
  });

  it("rename keeps the gear filed, and reorder is what the drag commits", async () => {
    await captureVaultItems(db as any, VAULT, [cap("Duplex", "Shelter")]);
    const shelter = (await listVaultFolders(db as any, VAULT))[0]!;
    await applyVaultFolderOp(db as any, VAULT, { t: "rename", id: shelter.id, name: "Tents" });
    expect((await listVaultItems(db as any, VAULT))[0]!.folderId).toBe(shelter.id);

    await applyVaultFolderOp(db as any, VAULT, { t: "add", name: "Cook" });
    const ids = (await listVaultFolders(db as any, VAULT)).map((f) => f.id);
    await applyVaultFolderOp(db as any, VAULT, { t: "reorder", ids: [ids[1]!, ids[0]!] });
    expect((await listVaultFolders(db as any, VAULT)).map((f) => f.name)).toEqual(["Cook", "Tents"]);
  });
});

// ---------------------------------------------------------------------------
// the nightly reaper
// ---------------------------------------------------------------------------
describe("vault reaping — bounding a table nothing else ever shrinks", () => {
  let db: DB;
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

  // a vault row + one piece of gear in it, last seen `days` ago
  async function seedVault(days: number): Promise<number> {
    const [row] = await db
      .insert(vaults)
      .values({ tokenHash: `hash-${days}-${Math.round(Math.random() * 1e9)}`, lastSeenAt: ago(days) })
      .returning();
    await captureVaultItems(db as any, row!.id, [
      { normKey: "", name: `Thing ${row!.id}`, brand: "Maker", weightMg: 100 } as any,
    ]);
    return row!.id;
  }

  beforeEach(async () => {
    db = await freshDb();
  });

  it("soft-deletes a vault past the stale window and leaves a fresh one alone", async () => {
    const stale = await seedVault(200);
    const fresh = await seedVault(3);

    expect(await reapAbandonedVaults(db as any)).toEqual({ vaultsReaped: 1 });
    const rows = await db.select().from(vaults);
    expect(rows.find((r) => r.id === stale)!.deletedAt).not.toBeNull();
    expect(rows.find((r) => r.id === fresh)!.deletedAt).toBeNull();
    // SOFT — the gear is still there, which is what makes the revive possible
    expect(await listVaultItems(db as any, stale)).toHaveLength(1);
  });

  it("does not purge inside the grace window", async () => {
    const id = await seedVault(200);
    await reapAbandonedVaults(db as any);
    expect(await purgeDeletedVaults(db as any)).toEqual({ vaultsPurged: 0 });
    expect(await db.select().from(vaults)).toHaveLength(1);
  });

  it("purges past the grace, taking the gear and folders with it", async () => {
    const id = await seedVault(400);
    await applyVaultFolderOp(db as any, id, { t: "add", name: "Shelter" });
    await db.update(vaults).set({ deletedAt: ago(120) }).where(eq(vaults.id, id));

    expect(await purgeDeletedVaults(db as any)).toEqual({ vaultsPurged: 1 });
    expect(await db.select().from(vaults)).toHaveLength(0);
    // no orphans left behind — there's no DB-level FK doing this for us
    expect(await listVaultItems(db as any, id)).toHaveLength(0);
    expect(await listVaultFolders(db as any, id)).toHaveLength(0);
  });

  it("leaves another vault's gear alone when it purges one", async () => {
    const doomed = await seedVault(400);
    const keeper = await seedVault(1);
    await db.update(vaults).set({ deletedAt: ago(120) }).where(eq(vaults.id, doomed));

    await purgeDeletedVaults(db as any);
    expect(await listVaultItems(db as any, keeper)).toHaveLength(1);
  });

  it("batches, so one run can't issue an unbounded write", async () => {
    await seedVault(200);
    await seedVault(200);
    await seedVault(200);
    expect(await reapAbandonedVaults(db as any, { limit: 2 })).toEqual({ vaultsReaped: 2 });
    expect(await reapAbandonedVaults(db as any, { limit: 2 })).toEqual({ vaultsReaped: 1 });
  });
});

// ---------------------------------------------------------------------------
// ceilings — a vault's growth is bounded
// ---------------------------------------------------------------------------
describe("vault ceilings", () => {
  let db: DB;
  const VAULT = 1;
  beforeEach(async () => {
    db = await freshDb();
  });

  const cap = (over: Record<string, unknown> = {}) => ({
    normKey: vaultNormKey("Zpacks", "Duplex", null),
    brand: "Zpacks",
    name: "Duplex",
    weightMg: 539_000,
    ...over,
  }) as any;

  const itemCount = async () =>
    Number(
      (await db.select({ n: sql<number>`count(*)` }).from(vaultItems).where(eq(vaultItems.vaultId, VAULT)))[0]!.n,
    );

  it("at the item ceiling, updates still land but new keys are dropped", async () => {
    const now = new Date();
    await db.insert(vaultItems).values(
      Array.from({ length: VAULT_ITEMS_MAX }, (_, i) => ({
        vaultId: VAULT,
        normKey: vaultNormKey(null, `Seed ${i}`, null),
        name: `Seed ${i}`,
        weightMg: 1,
        timesSeen: 1,
        lastUsedAt: now,
        updatedAt: now,
      })),
    );
    await captureVaultItems(db as any, VAULT, [
      cap({ brand: undefined, name: "Seed 0", weightMg: 999 }), // update — rides free
      cap({ name: "Brand New Thing" }), // new key — over the ceiling, dropped
    ]);
    expect(await itemCount()).toBe(VAULT_ITEMS_MAX);
    const seed0 = await db
      .select()
      .from(vaultItems)
      .where(eq(vaultItems.normKey, vaultNormKey(null, "Seed 0", null)));
    expect(Number(seed0[0]!.weightMg)).toBe(999);
  });

  it("capture stops minting folders at the ceiling; the gear still lands, unfiled", async () => {
    await db.insert(vaultFolders).values(
      Array.from({ length: VAULT_FOLDERS_MAX }, (_, i) => ({
        vaultId: VAULT,
        name: `F${i}`,
        sortOrder: i + 1,
      })),
    );
    await captureVaultItems(db as any, VAULT, [cap({ folder: "One Folder Too Many" })]);
    const folders = await listVaultFolders(db as any, VAULT);
    expect(folders).toHaveLength(VAULT_FOLDERS_MAX);
    expect((await listVaultItems(db as any, VAULT))[0]!.folderId).toBeUndefined();

    // a folder that already exists still files its gear, ceiling or not
    await captureVaultItems(db as any, VAULT, [
      cap({ name: "Neoair", brand: "Therm-a-Rest", folder: "F0" }),
    ]);
    const neo = (await listVaultItems(db as any, VAULT)).find((r) => r.name === "Neoair")!;
    expect(neo.folderId).toBe(folders.find((f) => f.name === "F0")!.id);
  });

  it("a deliberate folder add refuses quietly at the ceiling", async () => {
    await db.insert(vaultFolders).values(
      Array.from({ length: VAULT_FOLDERS_MAX }, (_, i) => ({
        vaultId: VAULT,
        name: `F${i}`,
        sortOrder: i + 1,
      })),
    );
    expect(await applyVaultFolderOp(db as any, VAULT, { t: "add", name: "Overflow" })).toBe(false);
    expect(await listVaultFolders(db as any, VAULT)).toHaveLength(VAULT_FOLDERS_MAX);
  });
});

// ---------------------------------------------------------------------------
// a gear edit wins — the pin
// ---------------------------------------------------------------------------
// The rule these pin down: correcting a field on /gear is a statement that your
// value is the truth about your own gear, and capture — which runs automatically
// from every open editor — must not argue with it. The control case matters as much
// as the rest: an UNEDITED field still takes the newer capture, or the pin would be
// per-row rather than per-field and the gear would stop learning anything.

/** The one row every block below starts from. */
const DUPLEX = {
  normKey: vaultNormKey("Zpacks", "Duplex", null),
  brand: "Zpacks",
  name: "Duplex",
  weightMg: 539_000,
} as const;

/** The live row, or undefined — every assertion here reads through the same path
 *  the page does, so a merge rule that only works in SQL doesn't pass. */
async function only(db: DB, vaultId = 1) {
  return (await listVaultItems(db as any, vaultId))[0];
}

describe("a gear edit wins — the pin", () => {
  let db: DB;
  const VAULT = 1;
  let id: number;

  beforeEach(async () => {
    db = await freshDb();
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    id = (await only(db))!.id;
  });

  const edit = (patch: Record<string, unknown>, unpin?: string[]) =>
    applyVaultItemOp(db as any, VAULT, { t: "edit", id, patch, unpin } as any);

  it("an edited weight survives a capture that disagrees", async () => {
    await edit({ weightMg: 545_000 });
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, weightMg: 539_000 } as any]);
    expect((await only(db))!.weightMg).toBe(545_000);
  });

  it("an UNEDITED weight still takes the newer capture", async () => {
    // the control: without this the pin could be per-row and nobody would notice
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, weightMg: 512_000 } as any]);
    expect((await only(db))!.weightMg).toBe(512_000);
  });

  it("pinning one field leaves the rest open", async () => {
    // The capture keeps the same spelling on purpose: brand + name + variant ARE the
    // key, so varying the name here would be a different piece of gear rather than a
    // second opinion about this one (see "an edited spelling survives" below).
    await edit({ weightMg: 545_000 });
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, weightMg: 100, commonName: "Tent", classification: "base" } as any,
    ]);
    const row = (await only(db))!;
    expect(row.weightMg).toBe(545_000); // pinned
    expect(row.commonName).toBe("Tent"); // learned
    expect(row.classification).toBe("base"); // learned
  });

  it("an edited note survives a list that says something else", async () => {
    await edit({ description: "Mine, size M" });
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, description: "Sam carries this" } as any,
    ]);
    expect((await only(db))!.description).toBe("Mine, size M");
  });

  it("an unedited note is written once and then left alone", async () => {
    // coalesce, not last-write-wins: a list's note is as often about the trip as
    // about the gear, so the FIRST one stands until you correct it here
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, description: "first" } as any]);
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, description: "second" } as any]);
    expect((await only(db))!.description).toBe("first");
  });

  it("an edited price survives, and its currency goes with it", async () => {
    await edit({ priceCents: 69_900, currency: "GBP" });
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, priceCents: 39_900, currency: "USD" } as any,
    ]);
    const row = (await only(db))!;
    expect(row.priceCents).toBe(69_900);
    expect(row.currency).toBe("GBP");
  });

  it("clearing the price clears the currency with it", async () => {
    // one field with two columns — a currency left behind would be the money a
    // price nobody entered was in
    await edit({ priceCents: 69_900, currency: "GBP" });
    await edit({ priceCents: null });
    const row = (await only(db))!;
    // toEntry turns SQL nulls into absent fields — the shape the client sees
    expect(row.priceCents).toBeUndefined();
    expect(row.currency).toBeUndefined();
  });

  it("an unpinned currency follows the amount rather than lingering", async () => {
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, priceCents: 39_900, currency: "USD" } as any,
    ]);
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, priceCents: 42_000, currency: "CAD" } as any,
    ]);
    const row = (await only(db))!;
    expect(row.priceCents).toBe(42_000);
    expect(row.currency).toBe("CAD");
  });

  it("an edited spelling survives, and the list still lands on the same row", async () => {
    await edit({ name: "Duplex Flex", brand: "ZPacks" });
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    const rows = await listVaultItems(db as any, VAULT);
    expect(rows).toHaveLength(1); // one row, not two
    expect(rows[0]!.name).toBe("Duplex Flex");
    expect(rows[0]!.brand).toBe("ZPacks");
  });

  it("an edit does NOT re-key the row", async () => {
    // The key is the gear's identity; the spelling is a separate axis. Re-deriving
    // would orphan the row from the list feeding it, and capture would recreate the
    // old one within seconds — unprompted.
    await edit({ name: "Duplex Flex" });
    expect((await only(db))!.normKey).toBe(DUPLEX.normKey);
  });

  it("a cleared product URL stays cleared through a capture that carries one", async () => {
    await edit({ productUrl: null });
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, productUrl: "https://zpacks.com/duplex" } as any,
    ]);
    expect((await only(db))!.productUrl).toBeUndefined();
  });

  it("a cleared kcal stays cleared", async () => {
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, kcal: 250 } as any]);
    await edit({ kcal: null });
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, kcal: 250 } as any]);
    expect((await only(db))!.kcal).toBeUndefined();
  });

  it("an edited classification isn't re-flipped by a list", async () => {
    await edit({ classification: "worn" });
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, classification: "base" } as any]);
    expect((await only(db))!.classification).toBe("worn");
  });

  it("capture still bumps timesSeen and lastUsedAt on a fully pinned row", async () => {
    // usage is not content: the autocomplete ranks on these, and a corrected row is
    // still gear a list just reached for
    await edit({ name: "Duplex Flex", weightMg: 545_000, commonName: "Tent", kcal: 1 });
    const before = (await only(db))!;
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    const after = (await only(db))!;
    expect(after.timesSeen).toBe(before.timesSeen + 1);
    expect(Date.parse(after.lastUsedAt)).toBeGreaterThanOrEqual(Date.parse(before.lastUsedAt));
  });

  it("a weight edited to zero UN-pins it, so a list can teach it again", async () => {
    await edit({ weightMg: 545_000 });
    await edit({ weightMg: 0 });
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, weightMg: 531_000 } as any]);
    expect((await only(db))!.weightMg).toBe(531_000);
  });

  it("unpin releases a field", async () => {
    await edit({ weightMg: 545_000 });
    await edit({}, ["weight"]);
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, weightMg: 539_000 } as any]);
    expect((await only(db))!.weightMg).toBe(539_000);
  });

  it("reports which fields are pinned", async () => {
    expect((await only(db))!.pinned).toBeUndefined();
    await edit({ weightMg: 545_000, commonName: "Tent" });
    expect((await only(db))!.pinned).toEqual(["weight", "commonName"]);
  });

  it("a capture can't smuggle a pin", async () => {
    // sanitize() rebuilds every field explicitly with no spread, so a hostile
    // payload carrying pin flags is dropped rather than honoured
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, weightMg: 400_000, pinned: ["weight"], weightPinned: true } as any,
    ]);
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX, weightMg: 410_000 } as any]);
    expect((await only(db))!.weightMg).toBe(410_000);
  });
});

// ---------------------------------------------------------------------------
// adding gear by hand
// ---------------------------------------------------------------------------
describe("adding gear by hand", () => {
  let db: DB;
  const VAULT = 1;

  beforeEach(async () => {
    db = await freshDb();
  });

  const add = (over: Record<string, unknown> = {}) =>
    applyVaultItemOp(db as any, VAULT, {
      t: "add",
      brand: "Zpacks",
      name: "Duplex",
      weightMg: 539_000,
      ...over,
    } as any);

  it("adds a row no list ever carried, seen once", async () => {
    expect(await add()).toMatchObject({ item: { name: "Duplex" } });
    const row = (await only(db))!;
    expect(row.weightMg).toBe(539_000);
    expect(row.timesSeen).toBe(1);
  });

  it("pins what you typed, so the next capture can't undo it", async () => {
    await add({ weightMg: 545_000 });
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    expect((await only(db))!.weightMg).toBe(545_000);
  });

  it("LIFTS a tombstone, unlike capture", async () => {
    // the deliberate mirror of "SURVIVES a later capture" above: capture must never
    // resurrect a removed row, but asking for it back in as many words is exactly
    // the case the tombstone was always meant to allow
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    await removeVaultItem(db as any, VAULT, (await only(db))!.id);
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(0);
    expect(await add({ weightMg: 545_000 })).toMatchObject({ item: {} });
    const back = await listVaultItems(db as any, VAULT);
    expect(back).toHaveLength(1);
    expect(back[0]!.weightMg).toBe(545_000);
  });

  it("refuses a duplicate of a LIVE row, and writes nothing", async () => {
    await add();
    expect(await add({ weightMg: 999_000 })).toEqual({ refused: "duplicate" });
    expect((await only(db))!.weightMg).toBe(539_000);
  });

  it("does not bump timesSeen when it lifts a tombstone", async () => {
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    await removeVaultItem(db as any, VAULT, (await only(db))!.id);
    await add();
    expect((await only(db))!.timesSeen).toBe(1); // the capture's 1, not 2
  });

  it("files it in a folder you own", async () => {
    await applyVaultFolderOp(db as any, VAULT, { t: "add", name: "Shelter" });
    const folder = (await listVaultFolders(db as any, VAULT))[0]!;
    await add({ folderId: folder.id });
    expect((await only(db))!.folderId).toBe(folder.id);
  });

  it("refuses a folder from another gear, and stores nothing", async () => {
    await applyVaultFolderOp(db as any, 2, { t: "add", name: "Theirs" });
    const theirs = (await listVaultFolders(db as any, 2))[0]!;
    expect(await add({ folderId: theirs.id })).toBeNull();
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(0);
  });

  it("refuses a nameless add", async () => {
    expect(await add({ name: "   " })).toBeNull();
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(0);
  });

  it("takes a row with no weight yet — you own it, you just haven't weighed it", async () => {
    await add({ weightMg: undefined });
    const row = (await only(db))!;
    expect(row.weightMg).toBe(0);
    expect(row.pinned).toEqual(["name"]); // a zero weight pins nothing
  });

  it("REFUSES at the item ceiling, where capture drops silently", async () => {
    await db.insert(vaultItems).values(
      Array.from({ length: VAULT_ITEMS_MAX }, (_, i) => ({
        vaultId: VAULT,
        normKey: vaultNormKey(null, `Thing ${i}`, null),
        name: `Thing ${i}`,
        weightMg: 1,
      })),
    );
    expect(await add()).toEqual({ refused: "full" });
    // A key the gear already holds gets PAST the ceiling — it would add no row — so
    // it comes back as the duplicate it is rather than as a full gear.
    expect(
      await applyVaultItemOp(db as any, VAULT, { t: "add", name: "Thing 0", weightMg: 2 } as any),
    ).toEqual({ refused: "duplicate" });
  });

  it("caps and tidies a hand-typed row exactly as a captured one", async () => {
    await add({ brand: "B".repeat(500), name: "Ryan's kit", kcal: "9000" });
    const row = (await only(db))!;
    expect(row.brand).toHaveLength(120);
    expect(row.name).toBe("Ryan’s kit");
    expect(row.kcal).toBeUndefined(); // a string is not a kcal
  });
});

// ---------------------------------------------------------------------------
// editing a vault row
// ---------------------------------------------------------------------------
describe("editing a vault row", () => {
  let db: DB;
  const VAULT = 1;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("an edit can NEVER collide, because the key never moves", async () => {
    // The property that makes freezing norm_key safe. Two rows whose spellings fold
    // apart; rename one to exactly the other's spelling and both must survive.
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX } as any,
      { normKey: vaultNormKey("Durston", "X-Mid", null), brand: "Durston", name: "X-Mid", weightMg: 900_000 } as any,
    ]);
    const rows = await listVaultItems(db as any, VAULT);
    const xmid = rows.find((r) => r.name === "X-Mid")!;
    const res = await applyVaultItemOp(db as any, VAULT, {
      t: "edit",
      id: xmid.id,
      patch: { brand: "Zpacks", name: "Duplex" },
    } as any);
    expect(res).toMatchObject({ item: {} });
    const after = await listVaultItems(db as any, VAULT);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.normKey).sort()).toEqual(
      [DUPLEX.normKey, vaultNormKey("Durston", "X-Mid", null)].sort(),
    );
  });

  it("leaves an absent field untouched and clears a null one", async () => {
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, commonName: "Tent", productUrl: "https://x.test/a" } as any,
    ]);
    const id = (await only(db))!.id;
    await applyVaultItemOp(db as any, VAULT, {
      t: "edit",
      id,
      patch: { productUrl: null },
    } as any);
    const row = (await only(db))!;
    expect(row.commonName).toBe("Tent"); // absent from the patch
    expect(row.productUrl).toBeUndefined(); // explicitly cleared
  });

  it("refuses to blank the name, and changes nothing", async () => {
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    const id = (await only(db))!.id;
    expect(
      await applyVaultItemOp(db as any, VAULT, { t: "edit", id, patch: { name: "  " } } as any),
    ).toBeNull();
    expect((await only(db))!.name).toBe("Duplex");
  });

  it("does not resurrect a tombstoned row — restore is its own verb", async () => {
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    const id = (await only(db))!.id;
    await removeVaultItem(db as any, VAULT, id);
    await applyVaultItemOp(db as any, VAULT, { t: "edit", id, patch: { weightMg: 1 } } as any);
    expect(await listVaultItems(db as any, VAULT)).toHaveLength(0);
    expect((await listRemovedVaultItems(db as any, VAULT))[0]!.weightMg).toBe(1);
  });

  it("leaves lastUsedAt and timesSeen alone — an edit is not a use", async () => {
    await captureVaultItems(db as any, VAULT, [{ ...DUPLEX } as any]);
    const before = (await only(db))!;
    await applyVaultItemOp(db as any, VAULT, {
      t: "edit",
      id: before.id,
      patch: { weightMg: 545_000 },
    } as any);
    const after = (await only(db))!;
    expect(after.timesSeen).toBe(before.timesSeen);
    expect(after.lastUsedAt).toBe(before.lastUsedAt);
  });

  it("refuses an unknown op", async () => {
    expect(await applyVaultItemOp(db as any, VAULT, { t: "nope" } as any)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hostile input the new paths share with capture
// ---------------------------------------------------------------------------
describe("sanitize — bounds a direct POST can't get past", () => {
  let db: DB;
  const VAULT = 1;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("clamps an absurd weight instead of erroring the whole statement", async () => {
    // weight_mg is a bigint column: 1e19 used to reach it and take the entire
    // multi-row capture down, so one hostile row killed a whole list's gear.
    const n = await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, weightMg: 1e19 } as any,
      { normKey: "b", name: "Bag", weightMg: 100 } as any,
    ]);
    expect(n).toBe(2);
    expect((await listVaultItems(db as any, VAULT)).map((r) => r.weightMg).sort((a, b) => a - b)).toEqual([
      100, UNIT_WEIGHT_MAX_MG,
    ]);
  });

  it("caps a product URL but does NOT curl its apostrophes", async () => {
    // tidyText curls a letter-flanked apostrophe, which in a path rewrites the
    // address to a page that isn't there — shared/ops exempts URLs for this reason
    await captureVaultItems(db as any, VAULT, [
      { ...DUPLEX, productUrl: "https://x.test/men's-jacket" } as any,
    ]);
    expect((await only(db))!.productUrl).toBe("https://x.test/men's-jacket");
  });
});

// ---------------------------------------------------------------------------
// the per-list decision — the one thing that finally removes it
// ---------------------------------------------------------------------------
// Still plain node, like the rest of this file. The decision helpers are localStorage
// and nothing else, and useMyLists needs only a `window` to hang its cross-tab
// "storage" listener on — its IndexedDB store no-ops without an `indexedDB`, which
// node hasn't got, so forget()'s other half looks after itself.
//
// The globals are stubbed for THIS block alone rather than at module scope: the
// suites above run a WASM Postgres, and a `window` in scope is exactly the sort of
// thing that convinces a library it's in a browser.
describe("a list's vault decision — cleared when it's deleted, kept when it's forgotten", () => {
  const store = new Map<string, string>();
  const TOKEN = "edit-token-abc";
  // What /api/edit/delete does when it's called. Reassigned per test; a resolve is
  // the server accepting the delete.
  let onDelete: () => Promise<unknown> = () => Promise.resolve({});
  let deleteCalls = 0;
  let vault: typeof import("../app/composables/useVault");
  let useMyLists: typeof import("../app/composables/useMyLists").useMyLists;

  beforeAll(async () => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal("window", { addEventListener: () => {} });
    vi.stubGlobal("$fetch", (url: string) => {
      if (url !== "/api/edit/delete") throw new Error(`unexpected fetch: ${url}`);
      deleteCalls++;
      return onDelete();
    });
    // Imported HERE rather than at the top of the file, and it has to be. Nuxt's
    // `$fetch` is a MODULE BINDING (#build/fetch.mjs), and that module reads
    // globalThis once, when it first evaluates. Pull the composables in statically
    // and that happens before this hook — leaving a stub nothing will ever call and
    // a deleteList quietly trying the real network, which fails and reads as "the
    // server refused". Which is also why every helper below is reached through
    // `vault.`: an unqualified call is silently satisfied by the auto-import, and
    // that injects exactly the static import this dynamic one exists to avoid.
    vault = await import("../app/composables/useVault");
    ({ useMyLists } = await import("../app/composables/useMyLists"));
  });
  afterAll(() => vi.unstubAllGlobals());

  const entry = (): MyListEntry => ({
    origin: "created",
    editToken: TOKEN,
    shareCode: "SHARECODE001",
    slug: "trip-abc123",
    title: "Trip",
    totalMg: 0,
    version: 1,
    lastOpened: 1,
  });

  // A list this device holds, with both halves of the decision answered: yes it's
  // mine, except for the stove — which is what the chooser records when you untick
  // gear that belongs to whoever you planned the trip with.
  beforeEach(() => {
    store.clear();
    deleteCalls = 0;
    onDelete = () => Promise.resolve({});
    const my = useMyLists();
    for (const e of my.entries.value) my.forget(e.editToken);
    my.upsert(entry());
    vault.setVaultDecisionFor(TOKEN, "yes");
    vault.setVaultExclusionsFor(TOKEN, ["stove"]);
  });

  it("deleting the list takes its decision with it", async () => {
    const my = useMyLists();
    expect(await my.deleteList(TOKEN)).toBe(true);
    expect(my.entries.value).toEqual([]);
    expect(store.has(`gear.vault.for.${TOKEN}`)).toBe(false);
    expect(store.has(`gear.vault.not.${TOKEN}`)).toBe(false);
  });

  it("a list gone from the server already still gets its decision cleared", async () => {
    // deleteList treats a 404 as success — the list was deleted elsewhere, so its
    // answer is just as dead as if this call had done the deleting.
    onDelete = () => Promise.reject({ statusCode: 404 });
    const my = useMyLists();
    expect(await my.deleteList(TOKEN)).toBe(true);
    expect(store.has(`gear.vault.for.${TOKEN}`)).toBe(false);
    expect(store.has(`gear.vault.not.${TOKEN}`)).toBe(false);
  });

  it("a delete that didn't happen leaves the decision alone", async () => {
    // Offline, or the server refused: the list is still there and the editor puts
    // itself back. Clearing here would re-ask about a list that never went away.
    onDelete = () => Promise.reject({ statusCode: 500 });
    const my = useMyLists();
    expect(await my.deleteList(TOKEN)).toBe(false);
    expect(my.entries.value.map((e) => e.editToken)).toEqual([TOKEN]);
    expect(vault.vaultDecisionFor(TOKEN)).toBe("yes");
    expect([...vault.vaultExclusionsFor(TOKEN)]).toEqual(["stove"]);
  });

  it("forgetting a list keeps its decision — the list is still online", () => {
    // "Forget this list" in the editor. The edit link can bring this list back, and
    // when it does, the answer you already gave must still stand.
    const my = useMyLists();
    my.forget(TOKEN);
    expect(deleteCalls).toBe(0); // nothing was deleted server-side
    expect(my.entries.value).toEqual([]);
    expect(vault.vaultDecisionFor(TOKEN)).toBe("yes");
    expect([...vault.vaultExclusionsFor(TOKEN)]).toEqual(["stove"]);
  });

  it("a cleared decision reads as unanswered, not as a no", () => {
    // The distinction the editor runs on: "no" never asks again, "ask" is the
    // question still open. A token that comes back around must land on the latter.
    vault.clearVaultDecisionFor(TOKEN);
    expect(vault.vaultDecisionFor(TOKEN)).toBe("ask");
    expect(vault.vaultExclusionsFor(TOKEN).size).toBe(0);
  });

  it("clears nothing when there's no token to clear for", () => {
    // A draft has no edit token yet, and `gear.vault.for.` is nobody's key.
    store.set("gear.vault.for.", "yes");
    vault.clearVaultDecisionFor("");
    expect(store.has("gear.vault.for.")).toBe(true);
  });
});
