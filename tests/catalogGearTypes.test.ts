import { describe, expect, it } from "vitest";
import { catalogItems } from "../server/db/schema";
import { CATALOG_DDL, catalogGearTypes } from "../server/utils/catalog";
import { createTestDb } from "./helpers/db";

describe("catalog gear-type vocabulary", () => {
  it("returns distinct sorted active labels, not product names or retired types", async () => {
    const db = await createTestDb(CATALOG_DDL);
    await db.insert(catalogItems).values([
      { name: "Duplex", commonName: "Tent" },
      { name: "X-Mid", commonName: "Tent" },
      { name: "Beacon", commonName: "PLB" },
      { name: "Unknown", commonName: null },
      { name: "Blank", commonName: "" },
      { name: "Whitespace", commonName: "  " },
      { name: "Retired", commonName: "Retired type", status: "removed" },
      { name: "Merged", commonName: "Merged type", status: "merged" },
    ].map(row => ({ weightMg: 100_000, weightSource: "manufacturer" as const, ...row })));
    expect(await catalogGearTypes(db)).toEqual(["PLB", "Tent"]);
  });

  it("returns an empty vocabulary for an unseeded catalog", async () => {
    const db = await createTestDb(CATALOG_DDL);
    expect(await catalogGearTypes(db)).toEqual([]);
  });
});
