// Accuracy audit for the cited catalog research (stage-1 automated gate).
//
// Wrong weights are the catalog's one unforgivable bug, so before anything ships
// we re-derive every weight and sanity-check it three ways:
//   1. QUOTE CROSS-CHECK — re-compute mg from weight_value+unit and compare to a
//      gram/kg figure parsed out of the manufacturer's own quote. A mismatch
//      means a transcription or unit error (oz↔g, wrong number, etc.).
//   2. PLAUSIBILITY — flag weights outside a sane per-category range (catches
//      per-pole-vs-per-pair, missing variant, 10× slips).
//   3. HYGIENE — source_url is a real https URL; no duplicate identity carrying
//      two different weights; weight_source is manufacturer/measured.
//
// Note: the quote often contains BOTH a trail/primary figure and a secondary one
// (packed weight, a second size). We compare against the gram figure CLOSEST to
// the computed value so a legit secondary figure doesn't false-positive; a true
// error (no nearby gram figure) still trips.
//
// Run: npm run catalog:audit   (node + jiti, like the other scripts)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { csvToCatalogRows, specToMg, WEIGHT_SOURCES, type SpecUnit } from "./catalogCsv";
import { RANGE_G, runCatalogChecks } from "./catalogChecks";
import { readResearchFiles, type ResearchRow } from "./research";

const here = dirname(fileURLToPath(import.meta.url));
const researchDir = join(here, "..", "seed", "_research");

// Plausible per-category weight ranges (RANGE_G) are single-sourced in
// catalogChecks.ts so the CLI audit and the gating test agree exactly.

/** All gram-equivalent figures mentioned in a quote (kg converted to g). */
function gramsInQuote(q: string): number[] {
  const out: number[] = [];
  for (const m of q.matchAll(/(\d+(?:\.\d+)?)\s*kg/gi)) out.push(parseFloat(m[1]) * 1000);
  for (const m of q.matchAll(/(\d+(?:\.\d+)?)\s*g(?![a-z])/gi)) out.push(parseFloat(m[1]));
  return out;
}

const label = (r: ResearchRow) => `${r.brand ?? ""} ${r.name ?? "?"}${r.variant ? ` [${r.variant}]` : ""}`.trim();

function main() {
  const errors: string[] = [];
  const warns: string[] = [];
  const identity = new Map<string, { g: number; where: string }>();

  let total = 0;
  let quoteChecked = 0;

  for (const { file, rows, parseError } of readResearchFiles(researchDir)) {
    if (parseError) {
      errors.push(`[json] ${file}: ${parseError}`);
      continue;
    }
    for (const r of rows) {
      total++;
      const where = `${file}: ${label(r)}`;

      // hygiene: weight_source
      if (!(WEIGHT_SOURCES as readonly string[]).includes(r.weight_source ?? "")) {
        errors.push(`[source] ${where}: weight_source="${r.weight_source}"`);
      }
      // hygiene: url
      const url = (r.source_url ?? "").trim();
      if (!/^https?:\/\/.+/i.test(url)) errors.push(`[url] ${where}: bad source_url "${url}"`);

      // compute mg
      let mg: number;
      try {
        mg = specToMg(Number(r.weight_value), r.weight_unit as SpecUnit, r.weight_secondary);
      } catch (e) {
        errors.push(`[convert] ${where}: ${(e as Error).message}`);
        continue;
      }
      const g = mg / 1000;

      // plausibility
      const range = RANGE_G[r.category_hint ?? "other"] ?? RANGE_G.other;
      if (g < range[0] || g > range[1]) {
        warns.push(
          `[range] ${where}: ${g.toFixed(0)} g outside ${r.category_hint} range ${range[0]}–${range[1]} g | ${r.weight_value}${r.weight_unit}`,
        );
      }

      // quote cross-check vs the CLOSEST gram figure in the quote
      const grams = gramsInQuote(r.quote ?? "");
      if (grams.length) {
        quoteChecked++;
        const nearest = grams.reduce((a, b) => (Math.abs(b - g) < Math.abs(a - g) ? b : a));
        const diff = Math.abs(g - nearest);
        const tol = Math.max(8, 0.05 * nearest);
        if (diff > tol) {
          errors.push(
            `[quote] ${where}: computed ${g.toFixed(0)} g, nearest quote figure ${nearest} g (Δ${diff.toFixed(0)} g) | grams in quote: ${grams.join(", ")} | "${(r.quote ?? "").slice(0, 90)}"`,
          );
        }
      }

      // duplicate identity carrying a different weight
      const key = `${(r.brand ?? "").toLowerCase()}|${(r.name ?? "").toLowerCase()}|${(r.variant ?? "").toLowerCase()}`;
      const prev = identity.get(key);
      if (prev) {
        if (Math.abs(prev.g - g) > Math.max(8, 0.02 * g)) {
          errors.push(`[dup] ${where}: ${g.toFixed(0)} g conflicts with ${prev.g.toFixed(0)} g from ${prev.where}`);
        }
      } else {
        identity.set(key, { g, where });
      }
    }
  }

  // Standing CSV-level checks over the BUILT artifact (the shipped source of
  // truth): commentary-in-variant, same-product dups, case collisions,
  // colour-as-variant, provenance laundering, plausibility, pole units. These
  // are the same checks the gating vitest test enforces.
  let csvChecked = 0;
  try {
    const csv = readFileSync(join(here, "..", "seed", "catalog.csv"), "utf8");
    const csvRows = csvToCatalogRows(csv);
    csvChecked = csvRows.length;
    for (const f of runCatalogChecks(csvRows)) {
      (f.level === "error" ? errors : warns).push(`[${f.code}] ${f.message}`);
    }
  } catch (e) {
    warns.push(`[csv] could not run CSV checks (run catalog:build first?): ${(e as Error).message}`);
  }

  console.log(`\n=== Catalog accuracy audit (stage 1) ===`);
  console.log(`research rows: ${total} | quote-cross-checked: ${quoteChecked} | csv rows: ${csvChecked} | unique identities: ${identity.size}`);
  if (warns.length) {
    console.log(`\nWARNINGS (${warns.length}) — review, may be legit (heavy boots, per-pair poles, etc.):`);
    for (const w of warns) console.log("  ! " + w);
  }
  if (errors.length) {
    console.log(`\nERRORS (${errors.length}) — must resolve before shipping:`);
    for (const e of errors) console.log("  ✗ " + e);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ No hard errors. (${warns.length} warnings to eyeball.)`);
  }
}

main();
