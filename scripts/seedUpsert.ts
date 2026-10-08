// The seeder's upsert, lifted out of seed-catalog.ts so a test can run it on PGlite
// (the way seedRenames.ts sits beside it). Matches on (brand, name, variant), inserts
// a row the table lacks, rewrites one whose seeded columns differ — and the column
// list here IS the contract: a column added to the table that is missing from
// `changed` and `set` below is never backfilled onto an existing row, which is how a
// new column ships to production as null on every row the CSV already had.
import { and, eq, isNull } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import type { useDb } from "../server/utils/db";
import type { CatalogCsvRow } from "./catalogCsv";

type Db = Awaited<ReturnType<typeof useDb>>;

export interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

export async function upsertCatalogRows(db: Db, rows: readonly CatalogCsvRow[]): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (const row of rows) {
    const brandCond = row.brand === null ? isNull(catalogItems.brand) : eq(catalogItems.brand, row.brand);
    const variantCond = row.variant === null ? isNull(catalogItems.variant) : eq(catalogItems.variant, row.variant);

    const existing = await db
      .select()
      .from(catalogItems)
      .where(and(brandCond, eq(catalogItems.name, row.name), variantCond))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(catalogItems).values({
        brand: row.brand,
        name: row.name,
        commonName: row.commonName,
        variant: row.variant,
        categoryHint: row.categoryHint,
        weightMg: row.weightMg,
        kcal: row.kcal,
        weightSource: row.weightSource,
        sourceUrl: row.sourceUrl,
        searchTerms: row.searchTerms,
        slug: row.slug,
        verified: true, // seeded = owner-curated + cited
      });
      counts.inserted++;
      continue;
    }

    const cur = existing[0];
    const changed =
      Number(cur.weightMg) !== row.weightMg ||
      (cur.kcal ?? null) !== row.kcal ||
      cur.weightSource !== row.weightSource ||
      cur.sourceUrl !== row.sourceUrl ||
      cur.categoryHint !== row.categoryHint ||
      cur.searchTerms !== row.searchTerms ||
      cur.commonName !== row.commonName ||
      (cur.slug ?? null) !== row.slug ||
      cur.verified !== true;

    if (changed) {
      await db
        .update(catalogItems)
        .set({
          weightMg: row.weightMg,
          kcal: row.kcal,
          weightSource: row.weightSource,
          sourceUrl: row.sourceUrl,
          categoryHint: row.categoryHint,
          searchTerms: row.searchTerms,
          commonName: row.commonName,
          slug: row.slug,
          verified: true,
          updatedAt: new Date(),
        })
        .where(eq(catalogItems.id, cur.id));
      counts.updated++;
    } else {
      counts.unchanged++;
    }
  }
  return counts;
}
