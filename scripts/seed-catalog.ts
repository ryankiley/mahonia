// Idempotent catalog seeder. Reads the curated, cited seed/catalog.csv and
// upserts each row into catalog_items, matching on (brand, name, variant) so
// re-running never duplicates — it inserts new rows and updates changed
// weights/sources in place, except a visitor's cited correction the research hasn't moved
// past, which stays (seedUpsert.ts). Each row it writes also records what the research
// said (seed_weight_mg, seed_source_url). A row whose variant was tidied keeps its id
// (seedRenames.ts: same product, one orphan and one newcomer, renamed before the upsert),
// and a row the CSV stops naming is retired with a pointer to its successor, never deleted
// (seedRetire.ts). Seeded rows are owner-curated + cited, so they're marked verified=true.
//
// Run under Node 26 (the repo's pinned toolchain) via the `seed` npm script,
// which uses jiti (ships with Nuxt) to resolve the project's TS imports:
//   npm run seed
//
// Honors DATABASE_URL: writes to Neon when set, else local PGlite (.data/pglite).

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { catalogItems } from "../server/db/schema";
import { renameMovedVariants } from "./seedRenames";
import { retireOrphans } from "./seedRetire";
import { upsertSeedRows } from "./seedUpsert";
import { inAppVerified, notInResearch } from "./graduate";
import { itemDisplayName } from "../shared/weights";
import { useDb } from "../server/utils/db";
import { csvToCatalogRows } from "./catalogCsv";
import { CATALOG_CSV } from "./paths";

async function main() {
  const csv = readFileSync(CATALOG_CSV, "utf8");
  const rows = csvToCatalogRows(csv);
  console.log(`Loaded ${rows.length} rows from seed/catalog.csv`);

  const db = await useDb();

  const renamed = await renameMovedVariants(db, rows);
  if (renamed.catalog || renamed.vault) console.log(`Variants tidied: ${renamed.catalog} catalog rows and ${renamed.vault} My Gear rows renamed in place, ids kept.`);

  const { inserted, updated, unchanged, held, kept } = await upsertSeedRows(db, rows);
  // in-app rows the research doesn't have: the upsert never sees them, so say so here
  const unresearched = notInResearch(await inAppVerified(db), rows);
  if (held || unresearched.length)
    console.log(
      `${held + unresearched.length} rows verified in the app aren't in the research yet (${held} differ from it, ${unresearched.length} it doesn't have); ` +
        `the Graduate catalog workflow, or npm run catalog:graduate, writes them out.`,
    );
  if (kept.length) {
    console.log(`Kept ${kept.length} cited corrections visitors made that the research doesn't have; verify or undo each with the connector's admin tools:`);
    for (const k of kept)
      console.log(`  #${k.id} ${itemDisplayName(k.brand, k.name, k.variant)}: research ${k.researchMg / 1000} g, live ${k.liveMg / 1000} g (${k.sourceUrl ?? "no citation"})`);
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
