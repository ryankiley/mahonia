// Idempotent catalog seeder. Reads the curated, cited seed/catalog.csv and
// upserts each row into catalog_items, matching on (brand, name, variant) so
// re-running never duplicates — it inserts new rows and updates changed
// weights/sources in place. Seeded rows are owner-curated + cited, so they're
// marked verified=true.
//
// Run under Node 24 (the repo's pinned toolchain) via the `seed` npm script,
// which uses jiti (ships with Nuxt) to resolve the project's TS imports:
//   npm run seed
//
// Honors DATABASE_URL: writes to Neon when set, else local PGlite (.data/pglite).

import { readFileSync } from "node:fs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import { ensureCatalogSchema } from "../server/utils/catalog";
import { useDb } from "../server/utils/db";
import { csvToCatalogRows } from "./catalogCsv";
import { CATALOG_CSV } from "./paths";



async function main() {
  const csv = readFileSync(CATALOG_CSV, "utf8");
  const rows = csvToCatalogRows(csv);
  console.log(`Loaded ${rows.length} rows from seed/catalog.csv`);

  const db = await useDb();
  await ensureCatalogSchema(db);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of rows) {
    const brandCond = row.brand === null
      ? isNull(catalogItems.brand)
      : eq(catalogItems.brand, row.brand);
    const variantCond = row.variant === null
      ? isNull(catalogItems.variant)
      : eq(catalogItems.variant, row.variant);

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
        verified: true, // seeded = owner-curated + cited
      });
      inserted++;
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
          verified: true,
          updatedAt: new Date(),
        })
        .where(eq(catalogItems.id, cur.id));
      updated++;
    } else {
      unchanged++;
    }
  }

  // Prune stale seed-managed rows: anything verified=true that is no longer in
  // the CSV is an orphan from a rename / variant-change / removal (the upsert
  // matches on identity, so a renamed row would otherwise linger forever — this
  // is what left "Ghost Whisperer/2 Hoody" and the old "(current live...)"
  // variant behind on reseed). Community contributions (verified=false) are
  // never touched. Guarded so a failed/empty CSV can't wipe the catalog.
  let pruned = 0;
  if (rows.length > 50) {
    const sep = "\u0000";
    const key = (b: string | null, n: string, v: string | null) =>
      `${b ?? ""}${sep}${n}${sep}${v ?? ""}`;
    const wanted = new Set(rows.map((r) => key(r.brand, r.name, r.variant)));
    const seedManaged = await db
      .select({ id: catalogItems.id, brand: catalogItems.brand, name: catalogItems.name, variant: catalogItems.variant })
      .from(catalogItems)
      .where(eq(catalogItems.verified, true));
    const orphanIds = seedManaged
      .filter((r) => !wanted.has(key(r.brand, r.name, r.variant)))
      .map((r) => r.id);
    if (orphanIds.length) {
      for (let i = 0; i < orphanIds.length; i += 200) {
        await db.delete(catalogItems).where(inArray(catalogItems.id, orphanIds.slice(i, i + 200)));
      }
      pruned = orphanIds.length;
    }
  } else {
    console.warn(`Skipped prune (only ${rows.length} CSV rows — guard against wiping the catalog).`);
  }

  // Final count straight from the table.
  const all = await db.select({ id: catalogItems.id }).from(catalogItems);
  console.log(
    `Catalog seeded: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged, ${pruned} pruned.`,
  );
  console.log(`catalog_items now holds ${all.length} rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
