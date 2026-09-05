// Shared reader for the cited research JSON in seed/_research/*.json — used by both
// build-catalog.ts (emits the CSV) and audit-catalog.ts (accuracy gate). The row
// SHAPE and the read-every-file-and-parse loop were duplicated across the two; the
// per-row VALIDATION is intentionally different and stays in each script.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One row of cited research exactly as authored. Superset shape — each script
 *  validates only the fields it needs. `category_hint` is `string | null` (the
 *  wider of the two former local copies). */
export interface ResearchRow {
  // The maker, or a collab as its own brand ("Zpacks x Vaucluse"). The UI renders
  // brand + name joined, so `name` never starts with the brand ("Watch SE 3", not
  // "Apple Watch SE 3"; an eponymous product takes a descriptor: "Camping Pillow Strap").
  brand?: string | null;
  name?: string;
  // Size / config, in the catalog's house style (enforced by scripts/catalogChecks.ts
  // and tidied by shared/catalogQuality normalizeVariant):
  //   • S/M/L-family sizes are LETTERS — "M", "XL", "Men's M", "Women's XS/S" — on
  //     anything worn or carried. No "Size " prefix, no comma after the gender.
  //   • Sleep + shelter keep the maker's LENGTH words ("Regular", "Long", "Large").
  //   • Footwear states the region: "Men's US 9", "Women's US 8", "UK 8", "US 9" (unisex).
  //   • Worn-in-pairs apparel carries no unit label; only trekking poles say "per pair".
  //   • One weight per one thing reads "per bar" / "per stake"; several read "3-pack" or
  //     "sleeve of 10". A number and its unit are one token ("6ft", "400ml", "20F").
  //   • A config never hides in `name`: " - Regular", "(low)", "(2024)", "(SP129)" all go
  //     here. A size-named family is one name plus variants ("Food Bag" [L], not
  //     "Large Food Bag"), and a product-family name is singular ("Stuff Sack" [M]).
  variant?: string | null;
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
