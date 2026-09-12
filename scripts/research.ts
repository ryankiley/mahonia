// Shared reader for the cited research JSON in seed/_research/*.json — used by both
// build-catalog.ts (emits the CSV) and audit-catalog.ts (accuracy gate). The row
// SHAPE and the read-every-file-and-parse loop were duplicated across the two; the
// per-row VALIDATION is intentionally different and stays in each script.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttributeKey, RowAttributes } from "./catalogAttributes";

/** One row of cited research exactly as authored. Superset shape — each script
 *  validates only the fields it needs. `category_hint` is `string | null` (the
 *  wider of the two former local copies). */
export interface ResearchRow {
  // The maker, or a collab as its own brand ("Zpacks x Vaucluse"). The UI renders
  // brand + name joined, so `name` never starts with the brand ("Watch SE 3", not
  // "Apple Watch SE 3"; an eponymous product takes a descriptor: "Camping Pillow Strap").
  brand?: string | null;
  name?: string;
  // Size / config, in the catalog's house style. Every rule below is ENFORCED: the
  // built CSV by scripts/catalogChecks.ts and the cited rows by scripts/researchChecks.ts,
  // both under `npm test` (which CI runs on every PR) and `npm run catalog:audit`. A rule
  // that only warned drifted within weeks, so a convention is an error or it is not a
  // convention; the only warnings are judgment lists for a human (weight plausibility,
  // food rows still at net weight or without kcal, rows missing an axis their gear type
  // is sold by). normalizeVariant tidies what it can.
  //   • S/M/L-family sizes are LETTERS — "M", "XL", "Men's M", "Women's XS/S" — on
  //     anything worn or carried. No "Size " prefix, no comma after the gender.
  //   • Sleep + shelter keep the maker's LENGTH words ("Regular", "Long", "Large").
  //   • Footwear states the region: "Men's US 9", "Women's US 8", "UK 8", "US 9" (unisex).
  //   • Worn-in-pairs apparel carries no unit label; only trekking poles say "per pair".
  //   • A variant exists only to tell a row apart from a sibling, or to state a size the
  //     maker sells several of. "One size", "Unisex", "Standard" on a one-row product, and
  //     "per bar" on the only "Energy Bar" row all say nothing — leave the variant empty.
  //     A unit label ("per tablet") appears only beside a multi-pack sibling ("sleeve of
  //     10"), or on trekking poles ("per pair").
  //   • A food row weighs what you CARRY — contents plus pouch — whenever the maker prints a
  //     total/package weight or someone has weighed one (weight_source "measured"). A row
  //     that could only be sourced at net contents says "net" in its variant, and the audit
  //     lists it as a to-do. Bars and chews stay at label weight (a wrapper is a gram or two).
  //     Fuel canisters keep "net fuel": the weight is the gas alone, not the can.
  //   • Servings: a multi-serving pouch says "2 servings"; single-serving is the unmarked default
  //     ("1 serving" is filler). A maker's format name stays ("Pro-Pak").
  //   • Several of a thing read "3-pack" or "sleeve of 10". A number and its unit are one
  //     token ("6ft", "400ml", "20F").
  //   • A config never hides in `name`: " - Regular", "(low)", "(2024)", "(SP129)" all go
  //     here. A size-named family is one name plus variants ("Food Bag" [L], not
  //     "Large Food Bag"), and a product-family name is singular ("Stuff Sack" [M]).
  //   • The axes a variant STATES are read out of it at build time: "20F, 950FP, Regular"
  //     becomes temp_f 20, fill_power 950 and length "Regular" in the CSV's `attributes`
  //     column (scripts/catalogAttributes.ts, keyed on the gear type where a token is
  //     ambiguous). A variant that claims one axis twice ("Regular, Long") fails the build.
  //     Write in `attributes` only what the variant does NOT state.
  variant?: string | null;
  // Typed axes the variant doesn't state (an R-value, the rating of a quilt sold one way):
  // fit, size, torso, length, width, temp_f, fill_power, r_value, persons, volume_l,
  // capacity_mah, fuel_g, fuel, each in ONE canonical form (validateAttributes: an unknown
  // key, a "20°F", a fill power as a string all fail the build). The build merges these
  // over what it reads from the variant; a value that contradicts the variant fails the
  // CSV check. Vocabulary in shared/catalogAxes.ts, forms in catalogAttributes.ts.
  attributes?: RowAttributes | null;
  // Where a hand-written attribute came from, when it is NOT readable from the row's own
  // `quote` (a maker's spec page for an R-value the cited stockist listing omits). Held to
  // the kcal bar: a real URL plus a verbatim quote, together; either alone fails the build.
  // A value the row's own quote already states needs neither.
  attributes_source_url?: string | null;
  attributes_quote?: string | null;
  // Axes the row's gear type is sold by that the maker does NOT publish a single value for:
  // a garment whose weight names no size, a sack listed by flat dimensions only, a pack sold
  // as a 25–40 L range. Recorded after the page was read, so the audit's to-do list stops
  // naming the row and the next pass doesn't re-read the page. An axis here and in
  // `attributes` at once is an error.
  attributes_unpublished?: AttributeKey[] | null;
  category_hint?: string | null;
  // the item's common name ("tent", "trekking poles") — REQUIRED for a new row to build
  // (a row with no common_name here, no seed/common-names.json entry, and no derivable
  // noun fails the build). Authored inline so a new catalog add ships its common name.
  common_name?: string | null;
  weight_value?: number;
  weight_unit?: string;
  weight_secondary?: string | null;
  weight_source?: string;
  source_url?: string | null;
  quote?: string;
  // Per-unit food energy — food rows only. Carries its OWN citation (the weight's
  // source_url/quote often cite a spec page with no nutrition panel): kcal without
  // kcal_source_url + kcal_quote fails the build, same bar the weight is held to.
  kcal?: number | null;
  kcal_source_url?: string | null;
  kcal_quote?: string | null;
}

/** A parsed research file, or a parse error for it. Rows are `[]` when `parseError`
 *  is set — the CALLER decides how to bucket it (build → skipped/exit 0; audit →
 *  errors/exit 1), so the reader never swallows or logs the failure itself. */
export interface ResearchFile {
  file: string;
  rows: ResearchRow[];
  parseError?: string;
}

/** Read + JSON-parse every `*.json` under `researchDir`, sorted by filename. Never
 *  throws: a file that won't parse comes back with `parseError` set and `rows: []`. */
export function readResearchFiles(researchDir: string): ResearchFile[] {
  const files = readdirSync(researchDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((file) => {
    try {
      const parsed = JSON.parse(readFileSync(join(researchDir, file), "utf8")) as {
        rows?: ResearchRow[];
      };
      return { file, rows: parsed.rows ?? [] };
    } catch (e) {
      return { file, rows: [], parseError: (e as Error).message };
    }
  });
}
