import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import {
  captureVaultItems,
  listVaultItems,
  removeVaultItem,
  restoreVaultItem,
  searchVaultItems,
  setVaultItemPrice,
} from "../server/utils/vaultRepo";
import {
  captureFingerprint,
  captureFromList,
  isVaultWorthy,
  vaultNormKey,
} from "../shared/vault";
import { rankVaultRows } from "../server/utils/vaultRepo";
import type { Item } from "../shared/types";

type DB = ReturnType<typeof drizzle>;
async function freshDb(): Promise<DB> {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of VAULT_DDL) await db.execute(sql.raw(stmt));
  return db;
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

  it("finds gear by its GEAR TYPE, not just its product name", () => {
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

