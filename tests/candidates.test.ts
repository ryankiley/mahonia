import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import { CANDIDATES_DDL, corroborateCatalog, stageCandidates } from "../server/utils/candidates";

type DB = ReturnType<typeof drizzle>;
async function freshDb(): Promise<DB> {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of [...CATALOG_DDL, ...CANDIDATES_DDL]) await db.execute(sql.raw(stmt));
  return db;
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
