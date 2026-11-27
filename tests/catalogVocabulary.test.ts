import { describe, expect, it } from "vitest";
import { catalogItems } from "../server/db/schema";
import { CATALOG_DDL, catalogBrands, catalogGearTypes } from "../server/utils/catalog";
import { createTestDb } from "./helpers/db";

// The two vocabularies the editor suggests from: gear types under Gear type, makers under
// Brand in My Gear's edit dialog. Each is one label column of the verified catalog, once
// each, never a retired row's or a community guess's.
describe("catalog vocabularies", () => {
  const seed = async (rows: Partial<typeof catalogItems.$inferInsert>[]) => {
    const db = await createTestDb(CATALOG_DDL);
    await db.insert(catalogItems).values(rows.map((row) => ({ name: "Thing", weightMg: 100_000, weightSource: "manufacturer", verified: true, ...row })));
    return db;
  };

  it("returns the verified rows' distinct sorted gear types, not product names, retired types or community drift", async () => {
    const db = await seed([
      { name: "Duplex", commonName: "Tent" },
      { name: "X-Mid", commonName: "Tent" },
      { name: "Beacon", commonName: "PLB" },
      { name: "Unknown", commonName: null },
      { name: "Blank", commonName: "" },
      { name: "Whitespace", commonName: "  " },
      { name: "Retired", commonName: "Retired type", status: "removed" },
      { name: "Merged", commonName: "Merged type", status: "merged" },
      // promoted from typed items, gear type as typed (candidates.ts): never a suggestion
      { name: "Lanshan 2", commonName: "tent", verified: false, weightSource: "community" },
      { name: "Bilby", commonName: "shelter", verified: false, weightSource: "community" },
    ]);
    expect(await catalogGearTypes(db)).toEqual(["PLB", "Tent"]);
  });

  it("returns the verified rows' distinct sorted brands", async () => {
    const db = await seed([
      { brand: "Zpacks", name: "Duplex" },
      { brand: "Zpacks", name: "Plex Solo" },
      { brand: "Durston", name: "X-Mid" },
      { brand: null, name: "Unbranded" },
      { brand: "  ", name: "Whitespace" },
      { brand: "Retired Co", name: "Old", status: "removed" },
      { brand: "Guessed Co", name: "Typed", verified: false, weightSource: "community" },
    ]);
    expect(await catalogBrands(db)).toEqual(["Durston", "Zpacks"]);
  });

  it("returns empty vocabularies for an unseeded catalog", async () => {
    const db = await createTestDb(CATALOG_DDL);
    expect(await catalogGearTypes(db)).toEqual([]);
    expect(await catalogBrands(db)).toEqual([]);
  });
});
