import { describe, expect, it } from "vitest";
import { CATALOG_DDL, ensureCatalogSchema } from "../server/utils/catalog";
import { hydrateCatalogNames } from "../server/utils/listRepo";
import type { Item, ListSnapshot } from "../shared/types";
import { seedCatalogRow } from "./helpers/catalog";
import { createTestDb } from "./helpers/db";

function snap(items: Partial<Item>[]): ListSnapshot {
  return {
    shareCode: "X", slug: "x", title: "t", displayUnit: "g", version: 1, isPublic: false,
    folders: [],
    items: items.map((p, i) => ({ id: String(i), folderId: null, name: "", unitWeightMg: 0, qty: 1, classification: null, sortOrder: i, ...p })),
  };
}

describe("hydrateCatalogNames (trickle-down)", () => {
  it("resolves linked items to the catalog's CURRENT brand/name/variant", async () => {
    const db = await createTestDb(CATALOG_DDL);
    // catalog row was cleaned after this list linked it (variant '/ M' → ', M')
    const cid = (await seedCatalogRow(db, { brand: "Durston", name: "Kakwa 55", variant: "Ultra 200X, M", weightMg: 893010, weightSource: "manufacturer", verified: true })).id;

    const out = await hydrateCatalogNames(db, snap([
      // stored snapshot has the OLD flat name; linked, not overridden
      { name: "Kakwa 55 OLD", brand: "Durston", variant: "Ultra 200X / M", catalogItemId: cid },
      // custom-renamed: must keep the user's text
      { name: "my frankenpack", catalogItemId: cid, nameOverridden: true },
      // unlinked typed item: untouched
      { name: "homemade alcohol stove" },
    ]));

    expect(out.items[0]).toMatchObject({ brand: "Durston", name: "Kakwa 55", variant: "Ultra 200X, M" });
    expect(out.items[1].name).toBe("my frankenpack"); // nameOverridden respected
    expect(out.items[2].name).toBe("homemade alcohol stove"); // unlinked untouched
  });

  it("trickles the catalog common name down, but respects commonNameOverridden", async () => {
    const db = await createTestDb(CATALOG_DDL);
    const cid = (await seedCatalogRow(db, { brand: "Durston", name: "X-Mid Pro 1", commonName: "tent", weightMg: 439418, weightSource: "manufacturer", verified: true })).id;

    const out = await hydrateCatalogNames(db, snap([
      // linked, not overridden → shows the catalog's default common name
      { name: "X-Mid Pro 1", brand: "Durston", catalogItemId: cid, commonName: "stale" },
      // the user renamed the common name → their text must survive re-resolution
      { name: "X-Mid Pro 1", brand: "Durston", catalogItemId: cid, commonName: "my shelter", commonNameOverridden: true },
    ]));

    expect(out.items[0].commonName).toBe("tent"); // trickled down (overwrote "stale")
    expect(out.items[1].commonName).toBe("my shelter"); // commonNameOverridden respected
  });

  it("gates each field on its OWN flag — a renamed product still tracks the gear type", async () => {
    const db = await createTestDb(CATALOG_DDL);
    const cid = (await seedCatalogRow(db, { brand: "Durston", name: "X-Mid Pro 1", commonName: "tent", weightMg: 439418, weightSource: "manufacturer", verified: true })).id;

    const out = await hydrateCatalogNames(db, snap([
      // renamed the PRODUCT only: their name survives, the gear type still resolves
      { name: "my shelter", catalogItemId: cid, commonName: "stale", nameOverridden: true },
      // renamed the GEAR TYPE only: their label survives, the product name still resolves
      { name: "X-Mid OLD", catalogItemId: cid, commonName: "palace", commonNameOverridden: true },
      // both pinned: nothing about the text resolves (only a retired link would move)
      { name: "mine", catalogItemId: cid, commonName: "mine too", nameOverridden: true, commonNameOverridden: true },
    ]));

    expect(out.items[0]).toMatchObject({ name: "my shelter", commonName: "tent" });
    expect(out.items[1]).toMatchObject({ name: "X-Mid Pro 1", commonName: "palace" });
    expect(out.items[2]).toMatchObject({ name: "mine", commonName: "mine too" });
  });

  it("hands a retired row's link on to its successor, names and all", async () => {
    const db = await createTestDb(CATALOG_DDL);
    const bar = await seedCatalogRow(db, { brand: "Clif", name: "Builders Protein Bar (Chocolate Peanut Butter)", commonName: "Protein bar", weightMg: 68000, weightSource: "manufacturer", verified: true });
    const old = await seedCatalogRow(db, { brand: "Clif", name: "Builders Protein Bar (Chocolate Peanut Butter)", variant: "single bar", weightMg: 68000, weightSource: "manufacturer", verified: true, status: "merged", mergedIntoId: bar.id });

    const out = await hydrateCatalogNames(db, snap([
      { name: "Builders Protein Bar (Chocolate Peanut Butter)", brand: "Clif", variant: "single bar", catalogItemId: old.id },
      // renamed on both counts: keeps its text, but the link still moves on
      { name: "my bar", commonName: "snack", catalogItemId: old.id, nameOverridden: true, commonNameOverridden: true },
    ]));
    expect(out.items[0]).toMatchObject({ catalogItemId: bar.id, name: "Builders Protein Bar (Chocolate Peanut Butter)", variant: undefined, commonName: "Protein bar" });
    expect(out.items[1]).toMatchObject({ catalogItemId: bar.id, name: "my bar", commonName: "snack" });
  });

  it("falls back to the stored snapshot when the catalog row is gone", async () => {
    const db = await createTestDb(CATALOG_DDL);
    const out = await hydrateCatalogNames(db, snap([
      { name: "Discontinued Thing", brand: "OldCo", catalogItemId: 99999 },
    ]));
    expect(out.items[0]).toMatchObject({ brand: "OldCo", name: "Discontinued Thing" });
  });

  it("bootstraps the catalog table on first use (Neon request-path)", async () => {
    // a database where no catalog endpoint has ever run: hydration must ensure
    // the table itself, not 500 every list read until some other endpoint does
    // no DDL groups at all — an empty database is the point of this case
    const db = await createTestDb();
    ensureCatalogSchema.reset();
    const out = await hydrateCatalogNames(db, snap([
      { name: "Copied Thing", catalogItemId: 1 },
    ]));
    expect(out.items[0]!.name).toBe("Copied Thing");
  });
});
