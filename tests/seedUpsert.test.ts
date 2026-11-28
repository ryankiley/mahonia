// The reseed's upsert (scripts/seedUpsert.ts): the table is read once and matched in
// memory, so what is pinned here is that the answer is the one a row-by-row match gave.
// Run on PGlite against the real table.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL, proposeCorrection, recentChanges } from "../server/utils/catalog";
import { undoCatalogEdit } from "../server/utils/catalogVerify";
import type { CatalogCsvRow } from "../scripts/catalogCsv";
import { upsertSeedRows, weightBeforeCorrections } from "../scripts/seedUpsert";
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
    expect(await upsertSeedRows(db, rows)).toEqual({ inserted: 3, updated: 0, unchanged: 0, held: 0, kept: [] });
    expect((await all()).map((r) => [r.brand, r.name, r.variant, r.verified])).toEqual([
      ["Zpacks", "Duplex", null, true],
      ["Zpacks", "Duplex", "Olive", true],
      [null, "Bandana", null, true],
    ]);
    expect(await upsertSeedRows(db, rows)).toEqual({ inserted: 0, updated: 0, unchanged: 3, held: 0, kept: [] });
    expect(await all()).toHaveLength(3);
  });

  it("takes over a row an admin verified in the app when the research names it, id kept", async () => {
    const [inApp] = await db
      .insert(schema.catalogItems)
      .values({ brand: "Zpacks", name: "Duplex", weightMg: 539_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/products/duplex-tent", sourceQuote: "19.0 oz / 539 g", verified: true, verifiedBy: 7, commonName: "Tent", categoryHint: "shelter", searchTerms: "tent shelter" })
      .returning();
    // every seeded field already agrees: the verifier alone makes it a change
    expect(await upsertSeedRows(db, [csv({})])).toEqual({ inserted: 0, updated: 1, unchanged: 0, held: 0, kept: [] });
    const [after] = await all();
    expect(after).toMatchObject({ id: inApp!.id, verified: true, verifiedBy: null, sourceQuote: null });
    expect(await upsertSeedRows(db, [csv({})])).toEqual({ inserted: 0, updated: 0, unchanged: 1, held: 0, kept: [] });
  });

  it("holds a row verified in the app that the research disagrees with, until the research agrees", async () => {
    // a research row the maker re-specced, corrected in the app: newer than the CSV
    const [inApp] = await db
      .insert(schema.catalogItems)
      .values({ brand: "Zpacks", name: "Duplex", weightMg: 524_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/products/duplex-tent-2026", sourceQuote: "18.5 oz / 524 g", verified: true, verifiedBy: 7, commonName: "Tent", categoryHint: "shelter", searchTerms: "tent shelter" })
      .returning();
    for (const stale of [csv({}), csv({ weightMg: 524_000 }), csv({ sourceUrl: "https://zpacks.com/products/duplex-tent-2026", weightSource: "measured", weightMg: 524_000 })]) {
      expect(await upsertSeedRows(db, [stale])).toEqual({ inserted: 0, updated: 0, unchanged: 0, held: 1, kept: [] });
      expect(await all()).toEqual([inApp]);
    }
    // what catalog:graduate writes back: the research agrees, and takes the row over
    const graduated = csv({ weightMg: 524_000, sourceUrl: "https://zpacks.com/products/duplex-tent-2026" });
    expect(await upsertSeedRows(db, [graduated])).toEqual({ inserted: 0, updated: 1, unchanged: 0, held: 0, kept: [] });
    expect(await all()).toEqual([expect.objectContaining({ id: inApp!.id, weightMg: 524_000, verified: true, verifiedBy: null, sourceQuote: null })]);
  });

  it("doesn't hold a retired row verified in the app: the research brings it back", async () => {
    const [gone] = await db
      .insert(schema.catalogItems)
      .values({ brand: "Zpacks", name: "Duplex", weightMg: 600_000, weightSource: "measured", verified: true, verifiedBy: 7, status: "removed" })
      .returning();
    expect(await upsertSeedRows(db, [csv({})])).toEqual({ inserted: 0, updated: 1, unchanged: 0, held: 0, kept: [] });
    expect(await all()).toEqual([expect.objectContaining({ id: gone!.id, status: "active", weightMg: 539_000, verifiedBy: null })]);
  });

  it("updates a changed row in place, id kept, and leaves the others alone", async () => {
    await upsertSeedRows(db, [csv({}), csv({ variant: "Olive" })]);
    const [plain] = await all();
    const stamp = plain!.updatedAt;
    expect(await upsertSeedRows(db, [csv({ weightMg: 524_000 }), csv({ variant: "Olive" })])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 1,
      held: 0,
      kept: [],
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
    expect(await upsertSeedRows(db, [csv({}), stove])).toEqual({ inserted: 0, updated: 2, unchanged: 0, held: 0, kept: [] });
    const [revived, claimed] = await all();
    expect([revived!.id, revived!.status, revived!.mergedIntoId]).toEqual([row!.id, "active", null]);
    expect([claimed!.verified, claimed!.commonName]).toEqual([true, "Stove"]);
  });

  it("writes an identity the CSV names twice once, the later row winning", async () => {
    expect(await upsertSeedRows(db, [csv({}), csv({ weightMg: 500_000 })])).toEqual({ inserted: 1, updated: 0, unchanged: 0, held: 0, kept: [] });
    expect((await all()).map((r) => Number(r.weightMg))).toEqual([500_000]);
  });

  it("writes a row's typed axes as the cell the build writes, and updates them when they change", async () => {
    const quilt = csv({ name: "Revelation", variant: "20F, Regular", attributes: { length: "Regular", temp_f: 20 } });
    await upsertSeedRows(db, [quilt]);
    expect((await all())[0]!.attributes).toBe("length=Regular; temp_f=20");
    // the same axes are no change
    expect(await upsertSeedRows(db, [quilt])).toMatchObject({ updated: 0, unchanged: 1 });
    // a research fix to one is
    expect(await upsertSeedRows(db, [{ ...quilt, attributes: { length: "Regular", temp_f: 20, fill_power: 850 } }])).toMatchObject({ updated: 1 });
    expect((await all())[0]!.attributes).toBe("length=Regular; temp_f=20; fill_power=850");
    // a row with none stores none
    await upsertSeedRows(db, [csv({ name: "Bandana", attributes: {} })]);
    expect((await all()).find((r) => r.name === "Bandana")!.attributes).toBeNull();
  });

  it("inserts past one batch", async () => {
    const many = Array.from({ length: 1203 }, (_, i) => csv({ name: `Stake ${i}` }));
    expect(await upsertSeedRows(db, many)).toEqual({ inserted: 1203, updated: 0, unchanged: 0, held: 0, kept: [] });
    expect(await all()).toHaveLength(1203);
  });
  // A visitor's cited correction is the newer word on a research row's weight until the
  // research moves; writing the CSV over it used to undo the fix with no trace in the edits.
  describe("a visitor's correction", () => {
    const fix = "https://zpacks.com/products/duplex-tent?spec";
    const correct = async (newWeightMg: number) => {
      const [row] = await all();
      expect((await proposeCorrection(db, { catalogItemId: row!.id, newWeightMg, sourceUrl: fix })).status).toBe("applied");
    };

    it("stays, with its citation, while the research still says the old weight, and is named in kept", async () => {
      await upsertSeedRows(db, [csv({})]);
      await correct(545_000);
      const [row] = await all();
      expect(await upsertSeedRows(db, [csv({})])).toEqual({
        inserted: 0,
        updated: 0,
        unchanged: 1,
        held: 0,
        kept: [{ id: row!.id, brand: "Zpacks", name: "Duplex", variant: null, researchMg: 539_000, liveMg: 545_000, sourceUrl: fix }],
      });
      expect((await all()).map((r) => [Number(r.weightMg), r.sourceUrl])).toEqual([[545_000, fix]]);
    });

    it("stays through a chain of corrections, while the seeded fields beside it still update", async () => {
      await upsertSeedRows(db, [csv({})]);
      await correct(545_000);
      await correct(548_000);
      const out = await upsertSeedRows(db, [csv({ searchTerms: "tent shelter duplex" })]);
      expect([out.updated, out.kept.map((k) => k.liveMg)]).toEqual([1, [548_000]]);
      expect((await all()).map((r) => [Number(r.weightMg), r.sourceUrl, r.searchTerms])).toEqual([[548_000, fix, "tent shelter duplex"]]);
    });

    it("gives way when the research moves, and can't then be undone over it", async () => {
      await upsertSeedRows(db, [csv({})]);
      await correct(545_000);
      expect(await upsertSeedRows(db, [csv({ weightMg: 550_000 })])).toMatchObject({ updated: 1, kept: [] });
      expect((await all()).map((r) => [Number(r.weightMg), r.sourceUrl])).toEqual([[550_000, csv({}).sourceUrl]]);
      const [edit] = await recentChanges(db, 1);
      expect(typeof (await undoCatalogEdit(db, edit!.id))).toBe("string");
      expect(Number((await all())[0]!.weightMg)).toBe(550_000);
    });

    it("is gone once undone, so the research's weight is what's there", async () => {
      await upsertSeedRows(db, [csv({})]);
      await correct(545_000);
      const [edit] = await recentChanges(db, 1);
      expect(await undoCatalogEdit(db, edit!.id)).toMatchObject({ rejected: false });
      expect(await upsertSeedRows(db, [csv({})])).toMatchObject({ kept: [] });
      expect((await all()).map((r) => [Number(r.weightMg), r.sourceUrl])).toEqual([[539_000, csv({}).sourceUrl]]);
    });

    it("doesn't hold a community row the research claims", async () => {
      await db.insert(schema.catalogItems).values({ brand: "Zpacks", name: "Duplex", weightMg: 539_000, weightSource: "community", verified: false });
      await correct(600_000); // a community row takes a correction at once
      expect(await upsertSeedRows(db, [csv({})])).toMatchObject({ updated: 1, kept: [] });
      expect((await all()).map((r) => [Number(r.weightMg), r.verified])).toEqual([[539_000, true]]);
    });
  });
});

describe("weightBeforeCorrections", () => {
  const fix = (oldWeightMg: number, newWeightMg: number) => ({ oldWeightMg, newWeightMg, correction: true });
  const verify = (oldWeightMg: number, newWeightMg: number) => ({ oldWeightMg, newWeightMg, correction: false });

  it("walks back the corrections that set the weight, to the weight before them", () => {
    expect(weightBeforeCorrections(300, [fix(100, 200), fix(200, 300)])).toBe(100);
  });

  it("stops at another writer: a reseed between two corrections, or an admin's verification", () => {
    expect(weightBeforeCorrections(300, [fix(100, 200), fix(250, 300)])).toBe(250);
    expect(weightBeforeCorrections(300, [verify(100, 200), fix(200, 300)])).toBe(200);
  });

  it("is null when the weight isn't the newest correction's", () => {
    expect(weightBeforeCorrections(200, [fix(100, 200), fix(200, 300)])).toBeNull();
    expect(weightBeforeCorrections(200, [verify(100, 200)])).toBeNull();
    expect(weightBeforeCorrections(539, [])).toBeNull();
  });
});
