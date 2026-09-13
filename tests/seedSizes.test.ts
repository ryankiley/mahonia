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
import { createTestDb, type TestDb } from "./helpers/db";

describe("sizesToWords", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(CATALOG_DDL, VAULT_DDL);
  });

  it("renames a letter-size catalog row in place, id kept, and leaves the rest", async () => {
    const [m] = await db.insert(schema.catalogItems).values({ brand: "CAYL", name: "6 Pocket Hiking Pants", variant: "M", weightMg: 253_000, weightSource: "manufacturer", verified: true, usageCount: 3 }).returning();
    const [mens] = await db.insert(schema.catalogItems).values({ brand: "Arc'teryx", name: "Cormac Hoody", variant: "Men's", weightMg: 160_000, weightSource: "manufacturer", verified: true, usageCount: 0 }).returning();
    const [range] = await db.insert(schema.catalogItems).values({ brand: "Osprey", name: "Exos 48", variant: "S/M", weightMg: 1_200_000, weightSource: "manufacturer", verified: true, usageCount: 0 }).returning();

    const first = await sizesToWords(db as never);
    expect(first).toEqual({ catalog: 1, vault: 0 });
    const rows = (await db.select().from(schema.catalogItems)) as { id: number; variant: string | null; usageCount: number }[];
    expect(rows.find((r) => r.id === m!.id)).toMatchObject({ variant: "Medium", usageCount: 3 });
    expect(rows.find((r) => r.id === mens!.id)!.variant).toBe("Men's");
    expect(rows.find((r) => r.id === range!.id)!.variant).toBe("S/M");

    // idempotent
    expect(await sizesToWords(db as never)).toEqual({ catalog: 0, vault: 0 });
  });

  it("leaves a row alone when its word form already exists as a row of its own", async () => {
    await db.insert(schema.catalogItems).values({ brand: "CAYL", name: "6 Pocket Hiking Pants", variant: "M", weightMg: 253_000, weightSource: "manufacturer", verified: true, usageCount: 0 });
    await db.insert(schema.catalogItems).values({ brand: "CAYL", name: "6 Pocket Hiking Pants", variant: "Medium", weightMg: 253_000, weightSource: "manufacturer", verified: true, usageCount: 0 });
    expect((await sizesToWords(db as never)).catalog).toBe(0);
    expect(await db.select().from(schema.catalogItems)).toHaveLength(2);
  });

  it("moves My Gear's rows with the catalog, key included", async () => {
    await db.execute(sql`insert into vaults (id, user_id) values (1, 1)`).catch(() => {});
    const key = vaultNormKey("Enlightened Equipment", "Revelation", "M");
    const [row] = await db.insert(schema.vaultItems).values({ vaultId: 1, normKey: key, brand: "Enlightened Equipment", name: "Revelation", variant: "M", weightMg: 560_000 } as never).returning();
    const r = await sizesToWords(db as never);
    expect(r.vault).toBe(1);
    const [after] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, row!.id));
    expect(after).toMatchObject({ variant: "Medium", normKey: vaultNormKey("Enlightened Equipment", "Revelation", "Medium") });
  });
});
