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
import {
  CATALOG_CSV_HEADERS,
  identityKey,
  isCitationUrl,
  isWeightSource,
  serializeCsv,
  specToMg,
  type SpecUnit,
} from "./catalogCsv";
import { CATALOG_CSV, COMMON_NAMES_JSON, RESEARCH_DIR } from "./paths";
import { readResearchFiles } from "./research";
import { normalizeVariant } from "../shared/catalogQuality";
import { deriveNoun } from "./searchTerms";
import { normalizeGearType } from "./gearTypes";

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

// a `type`, not an interface: serializeCsv takes Record<string, …> rows, and only an
// alias's object literal carries the implicit index signature that satisfies it
type BuiltRow = {
  brand: string;
  name: string;
  common_name: string;
  variant: string;
  category_hint: string;
  weight_mg: number;
  weight_source: string;
  source_url: string;
  kcal: number | null;
};

const identity = (r: { brand: string; name: string; variant: string }) =>
  identityKey(r.brand, r.name, r.variant);

// The default gear types, keyed by identity. Source of truth for the `common_name` CSV
// column — HAND-AUTHORED in seed/common-names.json (nothing generates it; it survives
// rebuilds, unlike a hand-edited CSV column). Missing rows fall back to deriveNoun(name).
//
// Because the key is brand|name|variant, editing any of those three in a research row
// orphans its entry here and the row silently falls back to a different label — so main()
// reports entries that matched nothing (see `orphaned` below) rather than letting the map
// rot quietly. New rows should carry `common_name` on the research row itself; this file
// is the one-time backfill for everything that predates that.
function loadCommonNames(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const arr = JSON.parse(readFileSync(COMMON_NAMES_JSON, "utf8")) as Array<{
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
  const usedCommonKeys = new Set<string>(); // which map entries actually matched a row

  for (const { file, rows, parseError } of readResearchFiles(RESEARCH_DIR)) {
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
      const source = (row.weight_source ?? "").trim().toLowerCase().split(/[^a-z]/)[0] ?? "";
      if (!isWeightSource(source)) {
        skipped.push(`${file}: ${label} — invalid weight_source "${row.weight_source}"`);
        continue;
      }
      const url = (row.source_url ?? "").trim();
      if (!isCitationUrl(url)) {
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

      // kcal — held to the same citation bar as the weight: a figure with no
      // kcal_source_url + kcal_quote of its own doesn't build (the weight's quote
      // cites a spec page, which rarely shows a nutrition panel). Food only:
      // kcal on a non-consumable row is a data error, not a judgment call.
      let kcal: number | null = null;
      if (row.kcal != null) {
        const k = Number(row.kcal);
        // 10k ceiling = sanity for a single retail unit (the largest rows here —
        // multi-serving freeze-dried pouches — sit under 1,500)
        if (!Number.isInteger(k) || k <= 0 || k > 10_000) {
          skipped.push(`${file}: ${label} — kcal must be a positive integer ≤ 10000, got "${row.kcal}"`);
          continue;
        }
        if (category !== "consumable") {
          skipped.push(`${file}: ${label} — kcal on a non-consumable row (${category})`);
          continue;
        }
        const kcalUrl = (row.kcal_source_url ?? "").trim();
        if (!isCitationUrl(kcalUrl) || !(row.kcal_quote ?? "").trim()) {
          skipped.push(`${file}: ${label} — kcal needs its own kcal_source_url + kcal_quote`);
          continue;
        }
        kcal = k;
      }

      const out: BuiltRow = {
        brand: (row.brand ?? "").trim(),
        name,
        common_name: "",
        variant: normalizeVariant(row.variant ?? ""),
        category_hint: category,
        weight_mg: weightMg,
        weight_source: source,
        source_url: url,
        kcal,
      };

      const key = identity(out);
      // A gear type is REQUIRED. Resolve it: the research row's own common_name wins, else the
      // hand-authored seed/common-names.json map, else a name-token derivation. normalizeGearType
      // collapses drift (singular/plural, spelling, synonyms) to the canonical label. A row that
      // resolves to nothing fails the build below — a new catalog entry must ship a gear type.
      const rowCommon = typeof row.common_name === "string" ? row.common_name.trim() : "";
      const mapped = commonNames.get(key);
      if (mapped) usedCommonKeys.add(key);
      out.common_name = normalizeGearType(rowCommon || mapped || deriveNoun(name) || "");
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

  // A map entry that matched no row is dead weight AND a warning sign: its brand/name/variant
  // was edited in the research file, so that row silently fell back to a derived label instead
  // of the one authored here. Surfacing it is the difference between noticing and not.
  const orphaned = [...commonNames.keys()].filter((k) => !usedCommonKeys.has(k));
  if (orphaned.length) {
    console.log(`\n  ⚠ ${orphaned.length} seed/common-names.json entr${orphaned.length === 1 ? "y" : "ies"} matched no row`);
    console.log(`    (identity changed in the research file → the row fell back to a derived gear type)`);
    for (const k of orphaned.slice(0, 10)) console.log(`      - ${k.replace(/\|/g, " ")}`);
    if (orphaned.length > 10) console.log(`      … and ${orphaned.length - 10} more`);
  }

  writeFileSync(CATALOG_CSV, serializeCsv(CATALOG_CSV_HEADERS, built), "utf8");

  // Report
  const byCat = new Map<string, number>();
  for (const r of built) byCat.set(r.category_hint, (byCat.get(r.category_hint) ?? 0) + 1);
  console.log(`\n✓ Wrote ${built.length} rows to seed/catalog.csv`);
  console.log(`  with kcal:   ${built.filter((r) => r.kcal != null).length}`);
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
