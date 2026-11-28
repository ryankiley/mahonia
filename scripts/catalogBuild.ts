// The catalog build itself: cited research rows in, the CSV's rows out. No file is
// read or written here, so the CLI (build-catalog.ts) and the test that holds the committed
// seed/catalog.csv to a fresh build (tests/catalog-build.test.ts) run the same code.
//
// Each research row carries the manufacturer's weight EXACTLY as cited
// (weight_value + weight_unit, plus weight_secondary for compound "1 lb 13 oz"
// specs) plus a source_url and a verbatim quote. This converts the cited
// weight to integer milligrams (specToMg, the same parser the editor uses),
// validates provenance, dedupes by brand+name+variant and sorts.

import { CATALOG_CSV_HEADERS, identityKey, isCitationUrl, isWeightSource, serializeCsv, specToMg } from "./catalogCsv";
import { extractAttributes, serializeAttributes, validateAttributes } from "./catalogAttributes";
import { researchGearType, type ResearchFile } from "./research";
import { CATALOG_CATEGORIES, normalizeVariant } from "../shared/catalogQuality";
import type { Unit } from "../shared/types";

// Canonical category order for a tidy, browsable CSV: the order the categories are
// declared in (RANGE_G, shared/catalogQuality.ts), so that order is the CSV's.
export const CATEGORY_ORDER = CATALOG_CATEGORIES;

// A `type`, not an `interface`: serializeCsv takes
// Record<string, string | number | null | undefined>, and only a type alias gets the
// implicit index signature that assignment needs.
export type BuiltRow = {
  brand: string;
  name: string;
  common_name: string;
  variant: string;
  attributes: string;
  attributes_unpublished: string;
  category_hint: string;
  weight_mg: number;
  weight_source: string;
  source_url: string;
  kcal: number | null;
};

export interface CatalogBuild {
  /** The CSV's rows, sorted. */
  rows: BuiltRow[];
  /** Research rows that didn't build, each with its file and reason. */
  skipped: string[];
  /** Rows that resolved to no gear type: the build fails on any. */
  missingCommon: BuiltRow[];
  /** Research rows carrying attributes their variant doesn't state. */
  handWritten: number;
}

export function buildCatalog(files: readonly ResearchFile[]): CatalogBuild {
  const built: BuiltRow[] = [];
  const seen = new Map<string, string>(); // identity -> source file (for dup reporting)
  const skipped: string[] = [];
  let handWritten = 0; // research rows carrying attributes their variant doesn't state

  for (const { file, rows, parseError } of files) {
    if (parseError) {
      // the whole file: it is held back until it reads cleanly, and the message names
      // every reason (invalid JSON, or each row that is not the shape a row has)
      skipped.push(`${file}: ${parseError}`);
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
      const unit = (row.weight_unit ?? "").trim() as Unit;
      let weightMg: number;
      try {
        weightMg = specToMg(Number(row.weight_value), unit, row.weight_secondary);
      } catch (e) {
        skipped.push(`${file}: ${label} — ${(e as Error).message}`);
        continue;
      }

      let category = (row.category_hint ?? "").trim().toLowerCase();
      if (!CATEGORY_ORDER.includes(category)) category = "other";

      // attributes — what research wrote by hand, each value in one canonical form. A row
      // whose attributes don't validate doesn't build (the research check names the
      // same finding, so `npm test` fails on it too rather than a row going quietly missing).
      const attrProblems = validateAttributes(row.attributes);
      if (attrProblems.length) {
        skipped.push(`${file}: ${label} — attributes: ${attrProblems.join("; ")}`);
        continue;
      }

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
        attributes: "",
        attributes_unpublished: (row.attributes_unpublished ?? []).join("; "),
        category_hint: category,
        weight_mg: weightMg,
        weight_source: source,
        source_url: url,
        kcal,
      };

      const key = identityKey(out.brand, out.name, out.variant);
      // A gear type is REQUIRED: the row's own common_name, normalized so drift (singular/plural,
      // spelling, synonyms) collapses to the canonical label. A row without one fails the build.
      out.common_name = researchGearType(row);
      // The row's axes: what its variant states, read mechanically now that the gear type
      // is known ("Regular" is a length on a quilt and a torso on a pack), plus what
      // research wrote by hand. A hand-written value that contradicts the variant ships
      // and fails the CSV check (attr-mismatch), like every other convention; the reader
      // itself never emits a value the checks would refuse.
      out.attributes = serializeAttributes({ ...extractAttributes(out.variant, out.common_name, category), ...(row.attributes ?? {}) });
      if (row.attributes && Object.keys(row.attributes).length) handWritten++;
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


  // Every catalog row must have a gear type (the pick-time default); one without fails the build.
  const missingCommon = built.filter((r) => !r.common_name);
  return { rows: built, skipped, missingCommon, handWritten };
}

/** The CSV text for a build's rows, byte for byte what seed/catalog.csv holds. */
export const catalogCsvText = (rows: BuiltRow[]): string => serializeCsv(CATALOG_CSV_HEADERS, rows);
