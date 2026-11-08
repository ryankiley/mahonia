import { describe, expect, it } from "vitest";
import { catalogItems } from "../server/db/schema";
import { CATALOG_DDL, catalogBrands } from "../server/utils/catalog";
import { createTestDb } from "./helpers/db";

// My Gear's edit dialog suggests these under Brand, as catalogGearTypes feeds Gear type:
// the verified catalog's makers, once each, never a retired row's or a community guess's.
describe("catalog brand vocabulary", () => {
  it("returns the verified rows' distinct sorted brands", async () => {
    const db = await createTestDb(CATALOG_DDL);
    await db.insert(catalogItems).values([
      { brand: "Zpacks", name: "Duplex" },
      { brand: "Zpacks", name: "Plex Solo" },
      { brand: "Durston", name: "X-Mid" },
      { brand: null, name: "Unbranded" },
      { brand: "  ", name: "Whitespace" },
      { brand: "Retired Co", name: "Old", status: "removed" },
      { brand: "Guessed Co", name: "Typed", verified: false, weightSource: "community" },
    ].map((row) => ({ weightMg: 100_000, weightSource: "manufacturer", verified: true, ...row })));
    expect(await catalogBrands(db)).toEqual(["Durston", "Zpacks"]);
  });

  it("returns an empty vocabulary for an unseeded catalog", async () => {
    const db = await createTestDb(CATALOG_DDL);
    expect(await catalogBrands(db)).toEqual([]);
  });
});
