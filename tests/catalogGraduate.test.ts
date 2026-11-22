// catalog:graduate's pieces (scripts/graduate.ts): the rows an admin verified in the app
// come out as research rows the audit passes, a measured row with no citation URL stays
// behind, and a graduated row replaces its own earlier copy in the file. Run on PGlite.
import { describe, expect, it } from "vitest";
import { CATALOG_DDL } from "../server/utils/catalog";
import { asResearchRow, inAppVerified, mergeResearch } from "../scripts/graduate";
import { runResearchChecks } from "../scripts/researchChecks";
import { seedCatalogRow } from "./helpers/catalog";
import { createTestDb } from "./helpers/db";

describe("catalog:graduate", () => {
  it("writes in-app verified rows as research the audit passes, and keeps an uncited one back", async () => {
    const db = await createTestDb(CATALOG_DDL);
    await seedCatalogRow(db, { brand: "Durston", name: "X-Mid 2", weightMg: 1_022_000, weightSource: "manufacturer", sourceUrl: "https://durstongear.com/products/x-mid-2", sourceQuote: "Total Weight: 36 oz / 1022 g", verified: true, verifiedBy: 7, commonName: "Tent", categoryHint: "shelter" });
    await seedCatalogRow(db, { brand: "Toaks", name: "Titanium 750 Pot", weightMg: 103_000, weightSource: "measured", verified: true, verifiedBy: 7, commonName: "Pot", categoryHint: "cook" });
    await seedCatalogRow(db, { brand: "Zpacks", name: "Duplex", weightMg: 539_000, weightSource: "manufacturer", sourceUrl: "https://zpacks.com/duplex", verified: true });
    await seedCatalogRow(db, { brand: "Nemo", name: "Hornet", weightMg: 900_000, verified: true, verifiedBy: 7, sourceUrl: "https://nemoequipment.com/hornet", status: "removed" });

    const rows = await inAppVerified(db as never);
    expect(rows.map((r) => r.name).sort()).toEqual(["Titanium 750 Pot", "X-Mid 2"]);
    const research = rows.map(asResearchRow);
    const cited = research.filter((r) => r !== null);
    expect(cited).toEqual([
      { brand: "Durston", name: "X-Mid 2", variant: null, category_hint: "shelter", common_name: "Tent", weight_value: 1022, weight_unit: "g", weight_source: "manufacturer", source_url: "https://durstongear.com/products/x-mid-2", quote: "Total Weight: 36 oz / 1022 g" },
    ]);
    const errors = runResearchChecks([{ file: "verified-in-app.json", rows: cited }]).filter((f) => f.level === "error");
    expect(errors).toEqual([]);
  });

  it("replaces a row's earlier copy and keeps the rest", () => {
    const before = [{ brand: "Durston", name: "X-Mid 2", variant: null, weight_value: 1000 }, { brand: "Toaks", name: "Pot", variant: null, weight_value: 90 }];
    const merged = mergeResearch(before, [{ brand: "Durston", name: "X-Mid 2", variant: null, weight_value: 1022 }]);
    expect(merged.map((r) => [r.name, r.weight_value])).toEqual([["X-Mid 2", 1022], ["Pot", 90]]);
  });
});
