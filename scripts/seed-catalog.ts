// Idempotent catalog seeder. Reads the curated, cited seed/catalog.csv and
// upserts each row into catalog_items, matching on (brand, name, variant) so
// re-running never duplicates — it inserts new rows and updates changed
// weights/sources in place, except a visitor's cited correction the research hasn't moved
// past, which stays (seedUpsert.ts). Each row it writes also records what the research
// said (seed_weight_mg, seed_source_url); on a database older than those columns the
// first run fills them in before anything reads them (seedBackfill.ts). A row whose
// variant was tidied keeps its id (seedRenames.ts: same product, one orphan and one
// newcomer, renamed before the upsert), and a row the CSV stops naming is retired with a
// pointer to its successor, never deleted (seedRetire.ts). Seeded rows are owner-curated +
// cited, so they're marked verified=true.
//
// Run under Node 26 (the repo's pinned toolchain) via the `seed` npm script,
// which uses jiti (ships with Nuxt) to resolve the project's TS imports:
//   npm run seed
//
// Honors DATABASE_URL: writes to Neon when set, else local PGlite (.data/pglite).

import { useDb } from "../server/utils/db";
import { seedCatalog } from "./seedCatalog";

useDb()
  .then(seedCatalog)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
