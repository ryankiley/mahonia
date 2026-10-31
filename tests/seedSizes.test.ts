// The reseed's in-place rename (scripts/seedSizes): a catalog row under the letter form
// takes the word form and KEEPS ITS ID, so list rows linked to it keep their link; My
// Gear's rows move with it, key included. Run on PGlite against the real tables.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import { sizesToWords } from "../scripts/seedSizes";
import { vaultNormKey } from "../shared/vault";
import { seedCatalogRow } from "./helpers/catalog";
import { createTestDb, type TestDb } from "./helpers/db";

/** A verified maker's row, as the reseed writes them. */
const cited = (db: TestDb, over: Parameters<typeof seedCatalogRow>[1]) =>
  seedCatalogRow(db, { weightSource: "manufacturer", verified: true, usageCount: 0, ...over });

describe("sizesToWords", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(CATALOG_DDL, VAULT_DDL);
  });

  it("renames a letter-size catalog row in place, id kept, and leaves the rest", async () => {
    const m = await cited(db, { brand: "CAYL", name: "6 Pocket Hiking Pants", variant: "M", weightMg: 253_000, usageCount: 3 });
    const mens = await cited(db, { brand: "Arc'teryx", name: "Cormac Hoody", variant: "Men's", weightMg: 160_000 });
    const range = await cited(db, { brand: "Osprey", name: "Exos 48", variant: "S/M", weightMg: 1_200_000 });

    const first = await sizesToWords(db);
    expect(first).toEqual({ catalog: 1, vault: 0 });
    const rows = (await db.select().from(schema.catalogItems)) as { id: number; variant: string | null; usageCount: number }[];
    expect(rows.find((r) => r.id === m.id)).toMatchObject({ variant: "Medium", usageCount: 3 });
    expect(rows.find((r) => r.id === mens.id)!.variant).toBe("Men's");
    expect(rows.find((r) => r.id === range.id)!.variant).toBe("S/M");

    // idempotent
    expect(await sizesToWords(db)).toEqual({ catalog: 0, vault: 0 });
  });

  it("leaves a row alone when its word form already exists as a row of its own", async () => {
    await cited(db, { brand: "CAYL", name: "6 Pocket Hiking Pants", variant: "M", weightMg: 253_000 });
    await cited(db, { brand: "CAYL", name: "6 Pocket Hiking Pants", variant: "Medium", weightMg: 253_000 });
    expect((await sizesToWords(db)).catalog).toBe(0);
    expect(await db.select().from(schema.catalogItems)).toHaveLength(2);
  });

  it("moves My Gear's rows with the catalog, key included", async () => {
    await db.execute(sql`insert into vaults (id, user_id) values (1, 1)`).catch(() => {});
    const key = vaultNormKey("Enlightened Equipment", "Revelation", "M");
    const [row] = await db.insert(schema.vaultItems).values({ vaultId: 1, normKey: key, brand: "Enlightened Equipment", name: "Revelation", variant: "M", weightMg: 560_000 } as never).returning();
    const r = await sizesToWords(db);
    expect(r.vault).toBe(1);
    const [after] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, row!.id));
    expect(after).toMatchObject({ variant: "Medium", normKey: vaultNormKey("Enlightened Equipment", "Revelation", "Medium") });
  });
});
