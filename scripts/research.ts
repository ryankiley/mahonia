// Shared reader for the cited research JSON in seed/_research/*.json — used by both
// build-catalog.ts (emits the CSV) and audit-catalog.ts (accuracy gate). The row
// SHAPE and the read-every-file-and-parse loop were duplicated across the two; the
// per-row VALIDATION is intentionally different and stays in each script.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttributeKey, RowAttributes } from "./catalogAttributes";
import { identityKey } from "./catalogCsv";
import { normalizeGearType } from "./gearTypes";
import { deriveNoun } from "./searchTerms";
import { normalizeVariant } from "../shared/catalogQuality";

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
  //   • A tent row weighs what is in the BOX — the maker's "packed" / "packaged" / "total" /
  //     "typical" weight, stakes and bags included — never the "trail" or "minimum" figure
  //     (fly, inner, poles), which sits 100–300 g lighter on the same page. A row that could
  //     only be sourced at trail weight says "trail weight" in its variant and is a to-do.
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

/** The hand-authored gear-type map (seed/common-names.json) keyed by identity, for rows
 *  that predate an inline `common_name`. Empty when the file is missing; a present but
 *  malformed map is a build error, never an excuse to silently fall back to guesses.
 *  Shared by the build (which also reports orphans) and the research checks (which need
 *  a row's gear type to know a tent from a stove). */
export function loadCommonNames(path: string): Map<string, string> {
  const m = new Map<string, string>();
  const entriesByIdentity = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // No map yet: every row falls back to its own common_name or a derived noun.
    // Anything else is a broken checked-in map and must stop the caller instead of
    // quietly removing every explicit gear type it carried.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return m;
    throw new Error(`Couldn't read common-name map ${path}: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Common-name map ${path} must be a JSON array.`);
  for (const [index, raw] of parsed.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Common-name map ${path} entry ${index + 1} must be an object.`);
    }
    const entry = raw as Record<string, unknown>;
    const text = (key: "brand" | "name" | "variant" | "common_name") => {
      const value = entry[key];
      if (value != null && typeof value !== "string") {
        throw new Error(`Common-name map ${path} entry ${index + 1} has a non-text ${key}.`);
      }
      return typeof value === "string" ? value.trim() : "";
    };
    // Validate every identity field before deciding an empty common_name makes
    // this entry irrelevant. Otherwise malformed, inactive-looking records can
    // stay in a checked-in map until someone fills in the name and breaks a build.
    const brand = text("brand");
    const name = text("name");
    const variant = text("variant");
    const cn = text("common_name");
    if (!cn) continue;
    const identity = identityKey(brand, name, normalizeVariant(variant));
    const prior = entriesByIdentity.get(identity);
    if (prior != null) {
      throw new Error(
        `Common-name map ${path} entry ${index + 1} duplicates entry ${prior} for ${identity}.`,
      );
    }
    entriesByIdentity.set(identity, index + 1);
    m.set(identity, cn);
  }
  return m;
}

const RESEARCH_TEXT_FIELDS = [
  "brand",
  "name",
  "variant",
  "attributes_source_url",
  "attributes_quote",
  "category_hint",
  "common_name",
  "weight_unit",
  "weight_secondary",
  "weight_source",
  "source_url",
  "quote",
  "kcal_source_url",
  "kcal_quote",
] as const;

/** The reader owns basic JSON shape, so downstream per-row checks can report bad
 * values instead of crashing on an untyped scalar's `.trim()` / `.toLowerCase()`.
 * It deliberately leaves semantic checks (required fields, units, attribute forms)
 * to build-catalog and researchChecks, where their specific diagnostics belong. */
function researchRowProblem(raw: unknown, position: number): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `row ${position} must be an object`;
  const row = raw as Record<string, unknown>;
  for (const field of RESEARCH_TEXT_FIELDS) {
    const value = row[field];
    if (value != null && typeof value !== "string") return `row ${position} has a non-text ${field}`;
  }
  for (const field of ["weight_value", "kcal"] as const) {
    const value = row[field];
    if (value != null && typeof value !== "number") return `row ${position} has a non-numeric ${field}`;
  }
  if (row.attributes != null && (typeof row.attributes !== "object" || Array.isArray(row.attributes))) {
    return `row ${position} has non-object attributes`;
  }
  if (row.attributes_unpublished != null) {
    if (!Array.isArray(row.attributes_unpublished) || row.attributes_unpublished.some((key) => typeof key !== "string")) {
      return `row ${position} has a non-text attributes_unpublished entry`;
    }
  }
  return null;
}

/** A research row's canonical gear type, resolved the way the build resolves it: the
 *  row's own `common_name`, else the hand-authored map, else a noun derived from the name. */
export function researchGearType(row: ResearchRow, commonNames: Map<string, string>): string {
  const own = typeof row.common_name === "string" ? row.common_name.trim() : "";
  const mapped = commonNames.get(identityKey((row.brand ?? "").trim(), (row.name ?? "").trim(), normalizeVariant(row.variant ?? "")));
  return normalizeGearType(own || mapped || deriveNoun((row.name ?? "").trim()) || "");
}

/** Read + JSON-parse every `*.json` under `researchDir`, sorted by filename. Never
 *  throws: a file that won't parse comes back with `parseError` set and `rows: []`. */
export function readResearchFiles(researchDir: string): ResearchFile[] {
  const files = readdirSync(researchDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((file) => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(researchDir, file), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error('expected an object with a "rows" array');
      }
      if (!("rows" in parsed)) throw new Error('expected an object with a "rows" array');
      const rows = (parsed as { rows?: unknown }).rows;
      if (!Array.isArray(rows)) throw new Error('expected "rows" to be an array');
      const problem = rows.map((row, index) => researchRowProblem(row, index + 1)).find(Boolean);
      if (problem) throw new Error(problem);
      return { file, rows: rows as ResearchRow[] };
    } catch (e) {
      return { file, rows: [], parseError: (e as Error).message };
    }
  });
}
