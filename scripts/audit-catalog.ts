// Accuracy audit for the cited catalog research (stage-1 automated gate).
//
// Wrong weights are the catalog's one unforgivable bug, so before anything ships
// every research row is re-derived and cross-checked against its own quote, and
// the built CSV is held to the formatting conventions. The checks themselves live
// in scripts/researchChecks.ts (cited-source level) and scripts/catalogChecks.ts
// (built-CSV level), and BOTH also run under `npm test` — so CI fails a PR on the
// same findings this prints. This script is the human-readable view of them, and
// the gate the prod reseed workflow runs before it writes.
//
// Run: npm run catalog:audit   (node + jiti, like the other scripts)

import { readFileSync } from "node:fs";
import { csvToCatalogRows } from "./catalogCsv";
import { runCatalogChecks } from "./catalogChecks";
import { runResearchChecks } from "./researchChecks";
import { CATALOG_CSV, RESEARCH_DIR } from "./paths";
import { readResearchFiles } from "./research";

function main() {
  const errors: string[] = [];
  const warns: string[] = [];

  const files = readResearchFiles(RESEARCH_DIR);
  const researchRows = files.reduce((n, f) => n + f.rows.length, 0);
  for (const f of runResearchChecks(files)) {
    (f.level === "error" ? errors : warns).push(`[${f.code}] ${f.message}`);
  }

  // Standing CSV-level checks over the BUILT artifact (the shipped source of truth).
  let csvChecked = 0;
  try {
    const csvRows = csvToCatalogRows(readFileSync(CATALOG_CSV, "utf8"));
    csvChecked = csvRows.length;
    for (const f of runCatalogChecks(csvRows)) {
      (f.level === "error" ? errors : warns).push(`[${f.code}] ${f.message}`);
    }
  } catch (e) {
    warns.push(`[csv] could not run CSV checks (run catalog:build first?): ${(e as Error).message}`);
  }

  console.log(`\n=== Catalog accuracy audit (stage 1) ===`);
  console.log(`research rows: ${researchRows} | csv rows: ${csvChecked}`);
  if (warns.length) {
    console.log(`\nWARNINGS (${warns.length}) — a human's list: weight plausibility, food rows still at net weight or without kcal:`);
    for (const w of warns) console.log("  ! " + w);
  }
  if (errors.length) {
    console.log(`\nERRORS (${errors.length}) — must resolve before shipping (npm test fails on these too):`);
    for (const e of errors) console.log("  ✗ " + e);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ No hard errors. (${warns.length} warnings to eyeball.)`);
  }
}

main();
