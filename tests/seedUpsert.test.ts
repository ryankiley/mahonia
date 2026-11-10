// The reseed's upsert (scripts/seedUpsert.ts): the table is read once and matched in
// memory, so what is pinned here is that the answer is the one a row-by-row match gave.
// Run on PGlite against the real table.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import type { CatalogCsvRow } from "../scripts/catalogCsv";
import { upsertSeedRows } from "../scripts/seedUpsert";
import { createTestDb, type TestDb } from "./helpers/db";

const csv = (over: Partial<CatalogCsvRow>): CatalogCsvRow => ({
  brand: "Zpacks",
  name: "Duplex",
  commonName: "Tent",
  variant: null,
  attributes: {},
  attributesUnpublished: [],
  categoryHint: "shelter",
  weightMg: 539_000,
  kcal: null,
  weightSource: "manufacturer",
  sourceUrl: "https://zpacks.com/products/duplex-tent",
  searchTerms: "tent shelter",
  ...over,
});

describe("upsertSeedRows", () => {
  let db: TestDb;
  const all = () => db.select().from(schema.catalogItems).orderBy(schema.catalogItems.id);
  beforeEach(async () => {
    db = await createTestDb(CATALOG_DDL);
  });

  it("inserts what the table doesn't hold, verified, and is a no-op the second time", async () => {
    const rows = [csv({}), csv({ variant: "Olive" }), csv({ brand: null, name: "Bandana", sourceUrl: null })];
    expect(await upsertSeedRows(db, rows)).toEqual({ inserted: 3, updated: 0, unchanged: 0 });
    expect((await all()).map((r) => [r.brand, r.name, r.variant, r.verified])).toEqual([
      ["Zpacks", "Duplex", null, true],
      ["Zpacks", "Duplex", "Olive", true],
      [null, "Bandana", null, true],
    ]);
    expect(await upsertSeedRows(db, rows)).toEqual({ inserted: 0, updated: 0, unchanged: 3 });
    expect(await all()).toHaveLength(3);
  });

  it("updates a changed row in place, id kept, and leaves the others alone", async () => {
    await upsertSeedRows(db, [csv({}), csv({ variant: "Olive" })]);
    const [plain] = await all();
    const stamp = plain!.updatedAt;
    expect(await upsertSeedRows(db, [csv({ weightMg: 524_000 }), csv({ variant: "Olive" })])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 1,
    });
    const [after, olive] = await all();
    expect([after!.id, Number(after!.weightMg)]).toEqual([plain!.id, 524_000]);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(stamp.getTime());
    expect(Number(olive!.weightMg)).toBe(539_000);
  });

  it("revives a retired row under its old id, and claims a community row", async () => {
    await upsertSeedRows(db, [csv({})]);
    const [row] = await all();
    await db.update(schema.catalogItems).set({ status: "merged", mergedIntoId: 999 }).where(eq(schema.catalogItems.id, row!.id));
    await db.insert(schema.catalogItems).values({ brand: "MSR", name: "PocketRocket 2", weightMg: 73_000, weightSource: "community", verified: false });

    const stove = csv({ brand: "MSR", name: "PocketRocket 2", commonName: "Stove", categoryHint: "cook", weightMg: 73_000, weightSource: "community", sourceUrl: null, searchTerms: null });
    expect(await upsertSeedRows(db, [csv({}), stove])).toEqual({ inserted: 0, updated: 2, unchanged: 0 });
    const [revived, claimed] = await all();
    expect([revived!.id, revived!.status, revived!.mergedIntoId]).toEqual([row!.id, "active", null]);
    expect([claimed!.verified, claimed!.commonName]).toEqual([true, "Stove"]);
  });

  it("writes an identity the CSV names twice once, the later row winning", async () => {
    expect(await upsertSeedRows(db, [csv({}), csv({ weightMg: 500_000 })])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect((await all()).map((r) => Number(r.weightMg))).toEqual([500_000]);
  });

  it("inserts past one batch", async () => {
    const many = Array.from({ length: 1203 }, (_, i) => csv({ name: `Stake ${i}` }));
    expect(await upsertSeedRows(db, many)).toEqual({ inserted: 1203, updated: 0, unchanged: 0 });
    expect(await all()).toHaveLength(1203);
  });
});
