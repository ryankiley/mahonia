// Build seed/catalog.csv from the cited research JSON in seed/_research/*.json.
//
// Each research row carries the manufacturer's weight EXACTLY as cited
// (weight_value + weight_unit, plus weight_secondary for compound "1 lb 13 oz"
// specs) plus a source_url and a verbatim quote. This script converts the cited
// weight to integer milligrams (specToMg, the same parser the editor uses),
// validates provenance, dedupes by brand+name+variant, sorts, and emits the CSV.
//
// Run: node node_modules/jiti/lib/jiti-cli.mjs scripts/build-catalog.ts
// (jiti ships with Nuxt and resolves the project's extensionless TS imports.)

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_CSV_HEADERS,
  serializeCsv,
  specToMg,
  WEIGHT_SOURCES,
  type SpecUnit,
} from "./catalogCsv";
import { readResearchFiles } from "./research";
import { normalizeVariant } from "../shared/catalogQuality";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const researchDir = join(root, "seed", "_research");
const outPath = join(root, "seed", "catalog.csv");

// Canonical category order for a tidy, browsable CSV.
const CATEGORY_ORDER = [
  "shelter",
  "sleep",
  "pack",
  "cook",
  "water",
  "clothing",
  "electronics",
  "firstaid",
  "consumable",
  "other",
];

interface BuiltRow {
  brand: string;
  name: string;
  variant: string;
  category_hint: string;
  weight_mg: number;
  weight_source: string;
  source_url: string;
}

const identity = (r: { brand: string; name: string; variant: string }) =>
  `${r.brand.toLowerCase()}|${r.name.toLowerCase()}|${r.variant.toLowerCase()}`;

function main() {
  const built: BuiltRow[] = [];
  const seen = new Map<string, string>(); // identity -> source file (for dup reporting)
  const skipped: string[] = [];

  for (const { file, rows, parseError } of readResearchFiles(researchDir)) {
    if (parseError) {
      skipped.push(`${file}: invalid JSON (${parseError})`);
      continue;
    }
    for (const row of rows) {
      const name = (row.name ?? "").trim();
      if (!name) {
        skipped.push(`${file}: row missing name`);
        continue;
      }
      const label = `${row.brand ?? ""} ${name} ${row.variant ?? ""}`.trim();

      // Normalize "measured (OutdoorGearLab)" / "manufacturer (via X)" → the bare
      // enum value; the attribution is already preserved in source_url.
      const source = (row.weight_source ?? "").trim().toLowerCase().split(/[^a-z]/)[0];
      if (!(WEIGHT_SOURCES as readonly string[]).includes(source)) {
        skipped.push(`${file}: ${label} — invalid weight_source "${row.weight_source}"`);
        continue;
      }
      const url = (row.source_url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        skipped.push(`${file}: ${label} — missing/invalid source_url`);
        continue;
      }
      const unit = (row.weight_unit ?? "").trim() as SpecUnit;
      let weightMg: number;
      try {
        weightMg = specToMg(Number(row.weight_value), unit, row.weight_secondary);
      } catch (e) {
        skipped.push(`${file}: ${label} — ${(e as Error).message}`);
        continue;
      }

      let category = (row.category_hint ?? "").trim().toLowerCase();
      if (!CATEGORY_ORDER.includes(category)) category = "other";

      const out: BuiltRow = {
        brand: (row.brand ?? "").trim(),
        name,
        variant: normalizeVariant(row.variant ?? ""),
        category_hint: category,
        weight_mg: weightMg,
        weight_source: source,
        source_url: url,
      };

      const key = identity(out);
      if (seen.has(key)) {
        skipped.push(`${file}: ${label} — duplicate of ${seen.get(key)} (kept first)`);
        continue;
      }
      seen.set(key, file);
      built.push(out);
    }
  }

  built.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category_hint) - CATEGORY_ORDER.indexOf(b.category_hint) ||
      a.brand.localeCompare(b.brand) ||
      a.name.localeCompare(b.name) ||
      a.variant.localeCompare(b.variant),
  );

  writeFileSync(outPath, serializeCsv(CATALOG_CSV_HEADERS, built), "utf8");

  // Report
  const byCat = new Map<string, number>();
  for (const r of built) byCat.set(r.category_hint, (byCat.get(r.category_hint) ?? 0) + 1);
  console.log(`\n✓ Wrote ${built.length} rows to seed/catalog.csv`);
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
