// The reseed retires a row the research stops naming instead of deleting it
// (scripts/seedRetire.ts), pointing it at its successor, so a list row or My Gear row
// that holds the old id still reaches a product (server/utils/catalog liveCatalogRows).
// Run on PGlite against the real tables.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL, liveCatalogRows } from "../server/utils/catalog";
import type { CatalogCsvRow } from "../scripts/catalogCsv";
import { retireOrphans } from "../scripts/seedRetire";
import { createTestDb, type TestDb } from "./helpers/db";

const URL = "https://www.clif.com/builders";
const csv = (over: Partial<CatalogCsvRow>): CatalogCsvRow => ({
  brand: "Clif",
  name: "Builders Protein Bar (Chocolate Peanut Butter)",
  commonName: "Protein bar",
  variant: null,
  attributes: {},
  attributesUnpublished: [],
  categoryHint: "consumable",
  weightMg: 68_000,
  kcal: 290,
  weightSource: "manufacturer",
  sourceUrl: URL,
  searchTerms: null,
  ...over,
});
const seeded = (over: Partial<typeof schema.catalogItems.$inferInsert>) => ({
  brand: "Clif",
  name: "Builders Protein Bar (Chocolate Peanut Butter)",
  variant: null,
  weightMg: 68_000,
  weightSource: "manufacturer",
  sourceUrl: URL,
  verified: true,
  ...over,
});

describe("retireOrphans", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(CATALOG_DDL);
  });

  it("retires a fold into its successor instead of deleting it, and readers follow", async () => {
    const [bar] = await db.insert(schema.catalogItems).values(seeded({})).returning();
    const [single] = await db.insert(schema.catalogItems).values(seeded({ variant: "single bar" })).returning();
    const [per] = await db.insert(schema.catalogItems).values(seeded({ variant: "per bar" })).returning();

    expect(await retireOrphans(db as never, [csv({})])).toEqual({ merged: 2, removed: 0 });
    const after = await db.select().from(schema.catalogItems);
    expect(after).toHaveLength(3);
    for (const id of [single!.id, per!.id]) {
      expect(after.find((r) => r.id === id)).toMatchObject({ status: "merged", mergedIntoId: bar!.id });
    }

    const live = await liveCatalogRows(db as never, [single!.id, per!.id, bar!.id]);
    expect([...live.entries()].map(([asked, r]) => [asked, r.id])).toEqual([
      [single!.id, bar!.id],
      [per!.id, bar!.id],
      [bar!.id, bar!.id],
    ]);
  });

  it("retires with no successor when nothing is certain, and readers find nothing", async () => {
    const [gone] = await db.insert(schema.catalogItems).values(seeded({ brand: "OldCo", name: "Discontinued Thing" })).returning();
    expect(await retireOrphans(db as never, [csv({})])).toEqual({ merged: 0, removed: 1 });
    const [after] = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, gone!.id));
    expect(after).toMatchObject({ status: "removed", mergedIntoId: null });
    expect((await liveCatalogRows(db as never, [gone!.id])).size).toBe(0);
  });

  it("re-aims a pointer whose target later retired, and is idempotent", async () => {
    const [old] = await db.insert(schema.catalogItems).values(seeded({ variant: "single bar" })).returning();
    const [mid] = await db.insert(schema.catalogItems).values(seeded({ variant: "per bar" })).returning();
    const [bar] = await db.insert(schema.catalogItems).values(seeded({})).returning();
    // an earlier seed pointed old at mid; mid has since retired too
    await db.update(schema.catalogItems).set({ status: "merged", mergedIntoId: mid!.id }).where(eq(schema.catalogItems.id, old!.id));

    // the reader follows the chain even before the reseed straightens it
    await db.update(schema.catalogItems).set({ status: "merged", mergedIntoId: bar!.id }).where(eq(schema.catalogItems.id, mid!.id));
    expect((await liveCatalogRows(db as never, [old!.id])).get(old!.id)?.id).toBe(bar!.id);

    await retireOrphans(db as never, [csv({})]);
    const [straight] = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, old!.id));
    expect(straight!.mergedIntoId).toBe(bar!.id);

    const stamp = straight!.updatedAt;
    await retireOrphans(db as never, [csv({})]);
    const [again] = await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, old!.id));
    expect(again!.updatedAt).toEqual(stamp);
  });

  it("never touches a community row or a row the CSV still names", async () => {
    const [community] = await db.insert(schema.catalogItems).values(seeded({ name: "Typed Bar", verified: false, weightSource: "community" })).returning();
    const [kept] = await db.insert(schema.catalogItems).values(seeded({})).returning();
    expect(await retireOrphans(db as never, [csv({})])).toEqual({ merged: 0, removed: 0 });
    const after = await db.select().from(schema.catalogItems);
    expect(after.find((r) => r.id === community!.id)!.status).toBe("active");
    expect(after.find((r) => r.id === kept!.id)!.status).toBe("active");
  });

  it("stops following a loop", async () => {
    const [a] = await db.insert(schema.catalogItems).values(seeded({ variant: "a" })).returning();
    const [b] = await db.insert(schema.catalogItems).values(seeded({ variant: "b" })).returning();
    await db.update(schema.catalogItems).set({ status: "merged", mergedIntoId: b!.id }).where(eq(schema.catalogItems.id, a!.id));
    await db.update(schema.catalogItems).set({ status: "merged", mergedIntoId: a!.id }).where(eq(schema.catalogItems.id, b!.id));
    expect((await liveCatalogRows(db as never, [a!.id])).size).toBe(0);
  });
});
