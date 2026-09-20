// The reseed's rename detection (scripts/seedRenames): a seed-managed row the CSV no
// longer names and a CSV row the database lacks, same product (brand, name, weight,
// source), one of each, is that row under a new variant — it KEEPS ITS ID, so list rows
// linked to it keep their link, and My Gear's rows move with it, key included. Run on
// PGlite against the real tables.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { VAULT_DDL } from "../server/utils/vaultSchema";
import type { CatalogCsvRow } from "../scripts/catalogCsv";
import { renameMovedVariants } from "../scripts/seedRenames";
import { vaultNormKey } from "../shared/vault";
import { createTestDb, type TestDb } from "./helpers/db";

const URL = "https://usshop.goldwin-global.com/products/gl05140";
const csv = (over: Partial<CatalogCsvRow>): CatalogCsvRow => ({
  brand: "Goldwin",
  name: "GORE-TEX 3L Jacket",
  commonName: "Rain jacket",
  variant: "JP 3",
  attributes: { size: "JP 3" },
  attributesUnpublished: [],
  categoryHint: "clothing",
  weightMg: 420_000,
  kcal: null,
  weightSource: "manufacturer",
  sourceUrl: URL,
  searchTerms: null,
  ...over,
});
const seeded = { brand: "Goldwin", name: "GORE-TEX 3L Jacket", variant: "Medium, JP 3", weightMg: 420_000, weightSource: "manufacturer", sourceUrl: URL, verified: true, usageCount: 2 };

describe("renameMovedVariants", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(CATALOG_DDL, VAULT_DDL);
  });

  it("moves a row to its new variant in place, id and usage kept, and is idempotent", async () => {
    const [old] = await db.insert(schema.catalogItems).values(seeded).returning();
    const [other] = await db.insert(schema.catalogItems).values({ ...seeded, name: "Star Trail Pack", variant: "JP 3", weightMg: 178_000, sourceUrl: "https://usshop.goldwin-global.com/products/gm95181" }).returning();
    const rows = [csv({}), csv({ name: "Star Trail Pack", variant: "JP 3", weightMg: 178_000, sourceUrl: "https://usshop.goldwin-global.com/products/gm95181" })];

    expect(await renameMovedVariants(db as never, rows)).toEqual({ catalog: 1, vault: 0 });
    const after = await db.select().from(schema.catalogItems);
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.id === old!.id)).toMatchObject({ variant: "JP 3", usageCount: 2 });
    expect(after.find((r) => r.id === other!.id)!.variant).toBe("JP 3");

    expect(await renameMovedVariants(db as never, rows)).toEqual({ catalog: 0, vault: 0 });
  });

  it("is not a rename when the weight or source differs, or the orphan is a community row", async () => {
    const [old] = await db.insert(schema.catalogItems).values(seeded).returning();
    expect((await renameMovedVariants(db as never, [csv({ weightMg: 430_000 })])).catalog).toBe(0);
    expect((await renameMovedVariants(db as never, [csv({ sourceUrl: "https://eushop.goldwin-global.com/products/gl05140" })])).catalog).toBe(0);
    expect((await db.select().from(schema.catalogItems)).find((r) => r.id === old!.id)!.variant).toBe("Medium, JP 3");

    await db.update(schema.catalogItems).set({ verified: false }).where(eq(schema.catalogItems.id, old!.id));
    expect((await renameMovedVariants(db as never, [csv({})])).catalog).toBe(0);
  });

  it("leaves a size split or a size dropped alone: one orphan, one newcomer, or nothing", async () => {
    await db.insert(schema.catalogItems).values(seeded);
    // one orphan, two newcomers at the same weight and page: a split, not a rename
    expect((await renameMovedVariants(db as never, [csv({ variant: "JP 3" }), csv({ variant: "JP 4" })])).catalog).toBe(0);
    // two orphans, one newcomer: a size dropped and the other renamed — ambiguous, left to the prune
    await db.insert(schema.catalogItems).values({ ...seeded, variant: "Large, JP 4" });
    expect((await renameMovedVariants(db as never, [csv({ variant: "JP 3" })])).catalog).toBe(0);
  });

  it("moves My Gear's rows with the catalog, key included", async () => {
    await db.insert(schema.catalogItems).values(seeded);
    await db.execute(sql`insert into vaults (id, user_id) values (1, 1)`).catch(() => {});
    const key = vaultNormKey("Goldwin", "GORE-TEX 3L Jacket", "Medium, JP 3");
    const [row] = await db.insert(schema.vaultItems).values({ vaultId: 1, normKey: key, brand: "Goldwin", name: "GORE-TEX 3L Jacket", variant: "Medium, JP 3", weightMg: 420_000 } as never).returning();
    expect(await renameMovedVariants(db as never, [csv({})])).toEqual({ catalog: 1, vault: 1 });
    const [after] = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, row!.id));
    expect(after).toMatchObject({ variant: "JP 3", normKey: vaultNormKey("Goldwin", "GORE-TEX 3L Jacket", "JP 3") });
  });
});
