// Idempotent catalog seeder. Reads the curated, cited seed/catalog.csv and
// upserts each row into catalog_items, matching on (brand, name, variant) so
// re-running never duplicates — it inserts new rows and updates changed
// weights/sources in place. A row whose variant was tidied keeps its id (seedRenames.ts:
// same product, one orphan and one newcomer, renamed before the upsert), and a row the
// CSV stops naming is retired with a pointer to its successor, never deleted
// (seedRetire.ts). Seeded rows are owner-curated + cited, so they're marked verified=true.
//
// Run under Node 24 (the repo's pinned toolchain) via the `seed` npm script,
// which uses jiti (ships with Nuxt) to resolve the project's TS imports:
//   npm run seed
//
// Honors DATABASE_URL: writes to Neon when set, else local PGlite (.data/pglite).

import { readFileSync } from "node:fs";
import { and, eq, isNull } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import { ensureCatalogSchema } from "../server/utils/catalog";
import { sizesToWords } from "./seedSizes";
import { refoldVaultIdentities } from "./seedIdentities";
import { renameMovedVariants } from "./seedRenames";
import { retireOrphans } from "./seedRetire";
import { useDb } from "../server/utils/db";
import { csvToCatalogRows } from "./catalogCsv";
import { CATALOG_CSV } from "./paths";

async function main() {
  const csv = readFileSync(CATALOG_CSV, "utf8");
  const rows = csvToCatalogRows(csv);
  console.log(`Loaded ${rows.length} rows from seed/catalog.csv`);

  const db = await useDb();
  await ensureCatalogSchema(db);

  const moved = await sizesToWords(db);
  if (moved.catalog || moved.vault) console.log(`Sizes as words: ${moved.catalog} catalog rows and ${moved.vault} My Gear rows renamed in place.`);
  const refolded = await refoldVaultIdentities(db);
  if (refolded) console.log(`Identities refolded: ${refolded} My Gear rows re-keyed in place.`);
  const renamed = await renameMovedVariants(db, rows);
  if (renamed.catalog || renamed.vault) console.log(`Variants tidied: ${renamed.catalog} catalog rows and ${renamed.vault} My Gear rows renamed in place, ids kept.`);

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
      cur.verified !== true ||
      // a retired row the research names again comes back under its old id, so the
      // lists that never stopped holding that id pick it up where they left off
      cur.status !== "active";

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
          status: "active",
          mergedIntoId: null,
          updatedAt: new Date(),
        })
        .where(eq(catalogItems.id, cur.id));
      updated++;
    } else {
      unchanged++;
    }
  }

  // Retire stale seed-managed rows: anything verified=true that is no longer in the
  // CSV is an orphan from a rename / variant-change / removal. Retired, not deleted:
  // lists and My Gear hold these ids (seedRetire.ts). Community contributions
  // (verified=false) are never touched. Guarded so a failed/empty CSV can't retire
  // the catalog.
  let retired = { merged: 0, removed: 0 };
  if (rows.length > 50) {
    retired = await retireOrphans(db, rows);
  } else {
    console.warn(`Skipped retiring (only ${rows.length} CSV rows — guard against emptying the catalog).`);
  }

  // Final count straight from the table.
  const active = await db.select({ id: catalogItems.id }).from(catalogItems).where(eq(catalogItems.status, "active"));
  console.log(
    `Catalog seeded: ${inserted} inserted, ${updated} updated, ${unchanged} unchanged; ` +
      `${retired.merged} retired into a successor, ${retired.removed} retired with none.`,
  );
  console.log(`catalog_items holds ${active.length} active rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
