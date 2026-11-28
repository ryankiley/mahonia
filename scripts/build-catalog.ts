// Build seed/catalog.csv from the cited research JSON in seed/_research/*.json. The build
// itself is scripts/catalogBuild.ts; this reads the research, fails loudly on what the build
// refuses, writes the file and reports. tests/catalog-build.test.ts holds the committed CSV to
// the same build, so a row added to the CSV by hand fails CI instead of vanishing next build.
//
// Run: npm run catalog:build
// (jiti ships with Nuxt and resolves the project's extensionless TS imports.)

import { writeFileSync } from "node:fs";
import { buildCatalog, catalogCsvText, CATEGORY_ORDER } from "./catalogBuild";
import { CATALOG_CSV, RESEARCH_DIR } from "./paths";
import { readResearchFiles } from "./research";

function main() {
  const { rows: built, skipped, missingCommon, handWritten } = buildCatalog(readResearchFiles(RESEARCH_DIR));

  // Fail BEFORE writing so no blank CSV is emitted.
  if (missingCommon.length) {
    console.error(`\n✗ ${missingCommon.length} row(s) have NO common name — every catalog row needs one.`);
    console.error(`  Add "common_name" to the research row:`);
    for (const r of missingCommon) console.error(`    - ${[r.brand, r.name, r.variant].filter(Boolean).join(" ")}`);
    process.exit(1);
  }
  writeFileSync(CATALOG_CSV, catalogCsvText(built), "utf8");

  // Report
  const byCat = new Map<string, number>();
  for (const r of built) byCat.set(r.category_hint, (byCat.get(r.category_hint) ?? 0) + 1);
  console.log(`\n✓ Wrote ${built.length} rows to seed/catalog.csv`);
  console.log(`  with kcal:   ${built.filter((r) => r.kcal != null).length}`);
  console.log(`  with attributes: ${built.filter((r) => r.attributes).length} (${handWritten} rows carry hand-written ones; ${built.filter((r) => r.attributes_unpublished).length} record an axis the maker doesn't publish)`);
  console.log("  by category:");
  for (const cat of CATEGORY_ORDER) {
    if (byCat.has(cat)) console.log(`    ${cat.padEnd(12)} ${byCat.get(cat)}`);
  }
  if (skipped.length) {
    console.log(`\n  skipped ${skipped.length} rows:`);
    for (const s of skipped) console.log(`    - ${s}`);
  }
}

main();
