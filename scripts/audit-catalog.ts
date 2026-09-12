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
import { runCatalogChecks, type Finding } from "./catalogChecks";
import { runResearchChecks } from "./researchChecks";
import { CATALOG_CSV, RESEARCH_DIR } from "./paths";
import { readResearchFiles } from "./research";

function main() {
  const errors: Finding[] = [];
  const warns: Finding[] = [];
  const bucket = (f: Finding) => (f.level === "error" ? errors : warns).push(f);
  const line = (f: Finding) => `[${f.code}] ${f.message}`;

  const files = readResearchFiles(RESEARCH_DIR);
  const researchRows = files.reduce((n, f) => n + f.rows.length, 0);
  for (const f of runResearchChecks(files)) bucket(f);

  // Standing CSV-level checks over the BUILT artifact (the shipped source of truth).
  // A CSV that will not even load (a malformed cell the strict parser refuses) is a
  // hard error, not a warning: the reseed workflow gates on this exit code, and the
  // seeder would throw on the same row.
  let csvChecked = 0;
  try {
    const csvRows = csvToCatalogRows(readFileSync(CATALOG_CSV, "utf8"));
    csvChecked = csvRows.length;
    for (const f of runCatalogChecks(csvRows)) bucket(f);
  } catch (e) {
    errors.push({ level: "error", code: "csv", message: `could not load seed/catalog.csv (run catalog:build first?): ${(e as Error).message}` });
  }

  console.log(`\n=== Catalog accuracy audit (stage 1) ===`);
  console.log(`research rows: ${researchRows} | csv rows: ${csvChecked}`);
  if (warns.length) {
    console.log(`\nWARNINGS (${warns.length}) — a human's list: weight plausibility, food rows still at net weight or without kcal, rows missing an axis their gear type is sold by:`);
    // grouped by code, so the 800-row attribute to-do list sits under one heading
    // instead of burying the dozen plausibility calls a human actually re-reads
    const byCode = new Map<string, Finding[]>();
    for (const w of warns) (byCode.get(w.code) ?? byCode.set(w.code, []).get(w.code)!).push(w);
    for (const [code, list] of [...byCode.entries()].sort((a, b) => a[1].length - b[1].length)) {
      console.log(`\n  [${code}] × ${list.length}`);
      for (const w of list) console.log("  ! " + line(w));
    }
  }
  if (errors.length) {
    console.log(`\nERRORS (${errors.length}) — must resolve before shipping (npm test fails on these too):`);
    for (const e of errors) console.log("  ✗ " + line(e));
    process.exitCode = 1;
  } else {
    console.log(`\n✓ No hard errors. (${warns.length} warnings to eyeball.)`);
  }
}

main();
