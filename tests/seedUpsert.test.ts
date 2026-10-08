// The seeder's upsert (scripts/seedUpsert) on PGlite: a row the table lacks is
// inserted with every seeded column, a row whose seeded columns match is left alone,
// and a row that differs in ANY seeded column — the slug included, the newest of
// them — is rewritten in place under its own id. The slug case is the one this file
// exists for: a column the upsert's change test forgets is a column production never
// gets on the rows it already holds.
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL } from "../server/utils/catalog";
import type { CatalogCsvRow } from "../scripts/catalogCsv";
import { upsertCatalogRows } from "../scripts/seedUpsert";
import { createTestDb, type TestDb } from "./helpers/db";

const csv = (over: Partial<CatalogCsvRow> = {}): CatalogCsvRow => ({
  brand: "Durston",
  name: "X-Mid 2",
  commonName: "Tent",
  variant: null,
  attributes: { persons: 2 },
  attributesUnpublished: [],
  categoryHint: "shelter",
  weightMg: 887_000,
  kcal: null,
  weightSource: "manufacturer",
  sourceUrl: "https://durstongear.com/products/x-mid-2",
  quote: "Complete Tent: 31.3 oz / 890 g",
  searchTerms: "tent shelter",
  slug: "durston/x-mid-2",
  ...over,
});

describe("upsertCatalogRows", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb(CATALOG_DDL);
  });

  it("inserts a new row with its slug, then leaves an unchanged row alone", async () => {
    expect(await upsertCatalogRows(db as never, [csv()])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    const [row] = await db.select().from(schema.catalogItems);
    expect(row).toMatchObject({ brand: "Durston", name: "X-Mid 2", slug: "durston/x-mid-2", verified: true, weightMg: 887_000 });
    expect(await upsertCatalogRows(db as never, [csv()])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it("backfills the slug onto a row seeded before the column existed, id kept", async () => {
    const [before] = await db
      .insert(schema.catalogItems)
      .values({ brand: "Durston", name: "X-Mid 2", variant: null, weightMg: 887_000, weightSource: "manufacturer", sourceUrl: "https://durstongear.com/products/x-mid-2", categoryHint: "shelter", searchTerms: "tent shelter", commonName: "Tent", verified: true, usageCount: 5 })
      .returning();
    expect(before!.slug).toBeNull();
    expect(await upsertCatalogRows(db as never, [csv()])).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const [after] = await db.select().from(schema.catalogItems);
    expect(after).toMatchObject({ id: before!.id, slug: "durston/x-mid-2", usageCount: 5 });
  });

  it("rewrites a changed weight in place and never touches a community row", async () => {
    await upsertCatalogRows(db as never, [csv()]);
    const [community] = await db
      .insert(schema.catalogItems)
      .values({ brand: null, name: "Homemade pot cozy", variant: null, weightMg: 20_000, weightSource: "community", verified: false })
      .returning();
    expect(await upsertCatalogRows(db as never, [csv({ weightMg: 890_000 })])).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const rows = await db.select().from(schema.catalogItems);
    expect(rows.find((r) => r.name === "X-Mid 2")!.weightMg).toBe(890_000);
    expect(rows.find((r) => r.id === community!.id)).toMatchObject({ slug: null, verified: false });
  });
});
