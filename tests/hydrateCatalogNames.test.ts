import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import * as schema from "../server/db/schema";
import { CATALOG_DDL, ensureCatalogSchema } from "../server/utils/catalog";
import { hydrateCatalogNames } from "../server/utils/listRepo";
import type { Item, ListSnapshot } from "../shared/types";

async function freshDb() {
  const db = drizzle(new PGlite(), { schema });
  for (const stmt of CATALOG_DDL) await db.execute(sql.raw(stmt));
  return db;
}

function snap(items: Partial<Item>[]): ListSnapshot {
  return {
    shareCode: "X", slug: "x", title: "t", displayUnit: "g", version: 1, isPublic: false,
    folders: [],
    items: items.map((p, i) => ({ id: String(i), folderId: null, name: "", unitWeightMg: 0, qty: 1, classification: null, sortOrder: i, ...p })),
  };
}

describe("hydrateCatalogNames (trickle-down)", () => {
  it("resolves linked items to the catalog's CURRENT brand/name/variant", async () => {
    const db = await freshDb();
    // catalog row was cleaned after this list linked it (variant '/ M' → ', M')
    const inserted = await db
      .insert(schema.catalogItems)
      .values({ brand: "Durston", name: "Kakwa 55", variant: "Ultra 200X, M", weightMg: 893010, weightSource: "manufacturer", verified: true })
      .returning({ id: schema.catalogItems.id });
    const cid = inserted[0]!.id;

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
    const db = await freshDb();
    const inserted = await db
      .insert(schema.catalogItems)
      .values({ brand: "Durston", name: "X-Mid Pro 1", commonName: "tent", weightMg: 439418, weightSource: "manufacturer", verified: true })
      .returning({ id: schema.catalogItems.id });
    const cid = inserted[0]!.id;

    const out = await hydrateCatalogNames(db, snap([
      // linked, not overridden → shows the catalog's default common name
      { name: "X-Mid Pro 1", brand: "Durston", catalogItemId: cid, commonName: "stale" },
      // the user renamed the common name → their text must survive re-resolution
      { name: "X-Mid Pro 1", brand: "Durston", catalogItemId: cid, commonName: "my shelter", commonNameOverridden: true },
    ]));

    expect(out.items[0].commonName).toBe("tent"); // trickled down (overwrote "stale")
    expect(out.items[1].commonName).toBe("my shelter"); // commonNameOverridden respected
  });

  it("falls back to the stored snapshot when the catalog row is gone", async () => {
    const db = await freshDb();
    const out = await hydrateCatalogNames(db, snap([
      { name: "Discontinued Thing", brand: "OldCo", catalogItemId: 99999 },
    ]));
    expect(out.items[0]).toMatchObject({ brand: "OldCo", name: "Discontinued Thing" });
  });

  it("bootstraps the catalog table on first use (Neon request-path)", async () => {
    // a database where no catalog endpoint has ever run: hydration must ensure
    // the table itself, not 500 every list read until some other endpoint does
    const db = drizzle(new PGlite(), { schema });
    ensureCatalogSchema.reset();
    const out = await hydrateCatalogNames(db, snap([
      { name: "Copied Thing", catalogItemId: 1 },
    ]));
    expect(out.items[0]!.name).toBe("Copied Thing");
  });
});
