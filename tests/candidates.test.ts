import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { CANDIDATES_DDL, corroborateCatalog, stageCandidates } from "../server/utils/candidates";
import { createTestDb, type TestDb } from "./helpers/db";

type DB = TestDb;
async function freshDb(): Promise<DB> {
  return createTestDb(CATALOG_DDL, CANDIDATES_DDL);
}
// stage the same typed item on N distinct lists
async function stageOnLists(db: DB, n: number, obs: { brand?: string; name: string; weightMg?: number }) {
  for (let i = 1; i <= n; i++) await stageCandidates(db as any, i, [obs]);
}
const catalogCount = async (db: DB) =>
  Number(((await db.execute(sql`select count(*)::int n from catalog_items`)) as any).rows[0].n);

describe("community intake — corroborateCatalog", () => {
  let db: DB;
  beforeEach(async () => { db = await freshDb(); });

  it("promotes a branded item seen on >=3 lists into a community row at the median weight", async () => {
    await stageOnLists(db, 1, { name: "Frobozz Megapack 9000", weightMg: 800_000 });
    await stageCandidates(db as any, 2, [{ name: "Frobozz Megapack 9000", weightMg: 820_000 }]);
    await stageCandidates(db as any, 3, [{ name: "Frobozz Megapack 9000", weightMg: 810_000 }]);
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(1);
    const rows = (await db.select().from(schema.catalogItems)) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Frobozz Megapack 9000", weightSource: "community", verified: false, weightMg: 810_000 });
    // idempotent: a second run promotes nothing
    expect((await corroborateCatalog(db as any)).promoted).toBe(0);
  });

  it("does NOT promote below the distinct-list threshold (K=3)", async () => {
    await stageOnLists(db, 2, { name: "Frobozz Megapack 9000", weightMg: 800_000 });
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(0);
    expect(await catalogCount(db)).toBe(0);
  });

  it("purges stale uncorroborated observations even when there is nothing to promote", async () => {
    await stageOnLists(db, 1, { name: "Frobozz Megapack 9000", weightMg: 800_000 });
    await db
      .update(schema.catalogCandidates)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(schema.catalogCandidates.listId, 1));

    const result = await corroborateCatalog(db as any);
    expect(result).toMatchObject({ scanned: 0, purged: 1 });
    expect(await db.select().from(schema.catalogCandidates)).toEqual([]);
  });

  it("rejects generic non-branded terms even when corroborated", async () => {
    await stageOnLists(db, 3, { name: "tent", weightMg: 900_000 });
    await stageOnLists(db, 3, { name: "water bottle", weightMg: 50_000 });
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(0);
    expect(r.rejected).toBeGreaterThanOrEqual(2);
    expect(await catalogCount(db)).toBe(0);
  });

  it("bumps usage on an existing catalog row instead of creating a duplicate", async () => {
    await db.insert(schema.catalogItems).values({
      brand: "Zpacks", name: "Plex Solo", weightMg: 411_000, weightSource: "manufacturer", verified: true, usageCount: 0,
    });
    await stageOnLists(db, 3, { brand: "Zpacks", name: "Plex Solo", weightMg: 415_000 });
    const r = await corroborateCatalog(db as any);
    expect(r.merged).toBe(1);
    expect(r.promoted).toBe(0);
    expect(await catalogCount(db)).toBe(1); // no dup created
    const [row] = (await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.name, "Plex Solo"))) as any[];
    expect(row.usageCount).toBeGreaterThan(0); // usage bumped
    expect(row.weightMg).toBe(411_000); // cited weight NOT overwritten by the community value
  });

  // The typed size or version is part of a candidate's identity, and rides into the
  // community row: a Long and a Regular of one quilt are two products with two weights,
  // and one row at a blended weight would be wrong for either.
  it("keeps a typed size or version as its own product, promoted with it", async () => {
    for (const [i, w] of [800_000, 820_000, 810_000].entries())
      await stageCandidates(db as any, i + 1, [{ name: "Frobozz Megapack 9000", variant: "Long", weightMg: w }]);
    for (const [i, w] of [700_000, 720_000, 710_000].entries())
      await stageCandidates(db as any, i + 11, [{ name: "Frobozz Megapack 9000", variant: "Regular", weightMg: w }]);
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(2);
    const rows = (await db.select().from(schema.catalogItems)) as any[];
    expect(rows.map((x) => [x.name, x.variant, x.weightMg]).sort()).toEqual([
      ["Frobozz Megapack 9000", "Long", 810_000],
      ["Frobozz Megapack 9000", "Regular", 710_000],
    ]);
  });

  // A typed row has no brand field: "Zpacks Frobozz 9000" is one string. The catalog
  // knows Zpacks, so the community row lands with the brand split out, spelled as the
  // catalog spells it, shaped like the cited rows.
  it("splits a known brand off the front of a typed name", async () => {
    await db.insert(schema.catalogItems).values({
      brand: "Zpacks", name: "Plex Solo", weightMg: 411_000, weightSource: "manufacturer", verified: true, usageCount: 0,
    });
    await stageOnLists(db, 3, { name: "zpacks Frobozz 9000", weightMg: 500_000 });
    await stageCandidates(db as any, 4, [{ name: "zpacks Frobozz 9000", weightMg: 505_000 }]);
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(1);
    const [row] = (await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.name, "Frobozz 9000"))) as any[];
    expect(row).toMatchObject({ brand: "Zpacks", name: "Frobozz 9000", weightSource: "community" });
  });

  it("recognizes an unambiguous first word of a multi-word catalog brand", async () => {
    const [alsek] = (await db.insert(schema.catalogItems).values({
      brand: "Katabatic Gear", name: "Alsek", weightMg: 650_000, weightSource: "manufacturer", verified: true, usageCount: 0,
    }).returning()) as any[];
    await stageOnLists(db, 3, { name: "Katabatic Alsek", weightMg: 655_000 });
    const r = await corroborateCatalog(db as any);
    expect(r.merged).toBe(1);
    expect(await catalogCount(db)).toBe(1);
    const [row] = (await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, alsek.id))) as any[];
    expect(row.usageCount).toBeGreaterThan(0);
  });

  it("learns a cottage maker only after two candidate names are independently corroborated", async () => {
    // SUL has three lists, enough to promote. Bilby has two, enough to corroborate
    // Timmermade as its maker but not enough to promote a second product itself.
    await stageOnLists(db, 3, { name: "Timmermade SUL 1.5", weightMg: 250_000 });
    await stageCandidates(db as any, 11, [{ name: "Timmermade Bilby", weightMg: 300_000 }]);
    await stageCandidates(db as any, 12, [{ name: "Timmermade Bilby", weightMg: 305_000 }]);
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(1);
    const [row] = (await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.name, "SUL 1.5"))) as any[];
    expect(row).toMatchObject({ brand: "Timmermade", name: "SUL 1.5", weightSource: "community" });
  });

  // and the dedup reads the size too: a typed "Revelation" in Long is the catalog's
  // Revelation in Long, not its Regular beside it
  it("merges a typed size into the catalog's row of that size", async () => {
    const [long] = (await db.insert(schema.catalogItems).values({
      brand: "Enlightened Equipment", name: "Revelation", variant: "Long", weightMg: 560_000, weightSource: "manufacturer", verified: true, usageCount: 0,
    }).returning()) as any[];
    await db.insert(schema.catalogItems).values({
      brand: "Enlightened Equipment", name: "Revelation", variant: "Regular", weightMg: 500_000, weightSource: "manufacturer", verified: true, usageCount: 0,
    });
    for (const i of [1, 2, 3])
      await stageCandidates(db as any, i, [{ brand: "Enlightened Equipment", name: "Revelation", variant: "Long", weightMg: 565_000 }]);
    const r = await corroborateCatalog(db as any);
    expect(r.merged).toBe(1);
    expect(r.promoted).toBe(0);
    const [row] = (await db.select().from(schema.catalogItems).where(eq(schema.catalogItems.id, long.id))) as any[];
    expect(row.usageCount).toBeGreaterThan(0);
    expect(await catalogCount(db)).toBe(2);
  });

  // "other" tops out at 1.6 kg; a typed "Tent" says which band applies, and the
  // gear type rides onto the row so a later pick fills it and "tent" finds it
  it("reads the typed gear type for the plausibility band, and keeps it on the row", async () => {
    for (const [i, w] of [1_700_000, 1_720_000, 1_710_000].entries())
      await stageCandidates(db as any, i + 1, [{ name: "Frobozz Palace 9000", commonName: "Tent", weightMg: w }]);
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(1);
    expect(r.rejected).toBe(0);
    const [row] = (await db.select().from(schema.catalogItems)) as any[];
    expect(row).toMatchObject({ name: "Frobozz Palace 9000", commonName: "Tent", searchTerms: "tent", categoryHint: "shelter", weightMg: 1_710_000 });
  });

  it("still rejects a weight no gear type can explain", async () => {
    await stageOnLists(db, 3, { name: "Frobozz Palace 9000", weightMg: 1_700_000 }); // no gear type, base: "other"
    await stageCandidates(db as any, 4, [{ name: "Frobozz Palace 9000", weightMg: 1_720_000 }]);
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(0);
    expect(r.rejected).toBe(1);
  });

  // a typed name that says MORE than the catalog row is a sibling product, not the
  // row itself: the names alone scored "Duplex Zip" as a duplicate of "Duplex"
  it("does not merge a typed name into a catalog row that lacks one of its words", async () => {
    await db.insert(schema.catalogItems).values({
      brand: "Zpacks", name: "Duplex", weightMg: 545_000, weightSource: "manufacturer", verified: true, usageCount: 0,
    });
    for (const [i, w] of [600_000, 605_000, 610_000].entries())
      await stageCandidates(db as any, i + 1, [{ brand: "Zpacks", name: "Duplex Zip", weightMg: w }]);
    const r = await corroborateCatalog(db as any);
    expect(r.merged).toBe(0);
    expect(r.promoted).toBe(1);
    expect(await catalogCount(db)).toBe(2);
  });

  it("still merges when the extra word is only a generic noun", async () => {
    await db.insert(schema.catalogItems).values({
      brand: "Zpacks", name: "Duplex", weightMg: 545_000, weightSource: "manufacturer", verified: true, usageCount: 0,
    });
    for (const [i, w] of [540_000, 545_000, 550_000].entries())
      await stageCandidates(db as any, i + 1, [{ brand: "Zpacks", name: "Duplex tent", weightMg: w }]);
    const r = await corroborateCatalog(db as any);
    expect(r.merged).toBe(1);
    expect(await catalogCount(db)).toBe(1);
  });

  it("leaves a corroborated item open when it has too few weights", async () => {
    // 3 lists but only 1 supplied a weight → below MIN_WEIGHTS, don't guess
    await stageCandidates(db as any, 1, [{ name: "Frobozz Megapack 9000", weightMg: 800_000 }]);
    await stageCandidates(db as any, 2, [{ name: "Frobozz Megapack 9000" }]);
    await stageCandidates(db as any, 3, [{ name: "Frobozz Megapack 9000" }]);
    const r = await corroborateCatalog(db as any);
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });
});
