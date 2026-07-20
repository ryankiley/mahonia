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

import { readFileSync, writeFileSync } from "node:fs";
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
import { deriveNoun } from "../shared/searchTerms";
import { normalizeGearType } from "../shared/gearTypes";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const researchDir = join(root, "seed", "_research");
const outPath = join(root, "seed", "catalog.csv");
const commonNamesPath = join(root, "seed", "common-names.json");

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
  common_name: string;
  variant: string;
  category_hint: string;
  weight_mg: number;
  weight_source: string;
  source_url: string;
}

const identity = (r: { brand: string; name: string; variant: string }) =>
  `${r.brand.toLowerCase()}|${r.name.toLowerCase()}|${r.variant.toLowerCase()}`;

// The generated default common names, keyed by identity. Source of truth for the
// `common_name` CSV column — authored in seed/common-names.json (survives rebuilds,
// unlike a hand-edited CSV column). Missing rows fall back to deriveNoun(name).
function loadCommonNames(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const arr = JSON.parse(readFileSync(commonNamesPath, "utf8")) as Array<{
      brand?: string;
      name?: string;
      variant?: string;
      common_name?: string;
    }>;
    for (const e of arr) {
      const cn = (e.common_name ?? "").trim();
      if (!cn) continue;
      m.set(
        identity({
          brand: (e.brand ?? "").trim(),
          name: (e.name ?? "").trim(),
          variant: normalizeVariant(e.variant ?? ""),
        }),
        cn,
      );
    }
  } catch {
    // no map yet → every row falls back to deriveNoun (or blank)
  }
  return m;
}

function main() {
  const built: BuiltRow[] = [];
  const seen = new Map<string, string>(); // identity -> source file (for dup reporting)
  const skipped: string[] = [];
  const commonNames = loadCommonNames();

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
        common_name: "",
        variant: normalizeVariant(row.variant ?? ""),
        category_hint: category,
        weight_mg: weightMg,
        weight_source: source,
        source_url: url,
      };

      const key = identity(out);
      // Common name is REQUIRED. Resolve it: the research row's own common_name wins, else the
      // generated seed/common-names.json map, else a name-token derivation. normalizeGearType
      // collapses drift (singular/plural, spelling, synonyms) to the canonical label. A row that
      // resolves to nothing fails the build below — a new catalog entry must ship a common name.
      const rowCommon = typeof row.common_name === "string" ? row.common_name.trim() : "";
      out.common_name = normalizeGearType(rowCommon || commonNames.get(key) || deriveNoun(name) || "");
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

  // Enforce: every catalog row must have a common name (the pick-time default). A row that
  // resolved to nothing — no research common_name, no map entry, no derivable noun — fails the
  // build so a new entry can't ship without one. Fail BEFORE writing so no blank CSV is emitted.
  const missingCommon = built.filter((r) => !r.common_name);
  if (missingCommon.length) {
    console.error(`\n✗ ${missingCommon.length} row(s) have NO common name — every catalog row needs one.`);
    console.error(`  Add "common_name" to the research row (or seed/common-names.json):`);
    for (const r of missingCommon) console.error(`    - ${[r.brand, r.name, r.variant].filter(Boolean).join(" ")}`);
    process.exit(1);
  }

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
