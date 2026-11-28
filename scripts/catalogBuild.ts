// The catalog build itself: cited research rows in, the CSV's rows out. No file is
// read or written here, so the CLI (build-catalog.ts) and the test that holds the committed
// seed/catalog.csv to a fresh build (tests/catalog-build.test.ts) run the same code.
//
// Each research row carries the manufacturer's weight EXACTLY as cited
// (weight_value + weight_unit, plus weight_secondary for compound "1 lb 13 oz"
// specs) plus a source_url and a verbatim quote. The research checks
// (researchChecks.ts) decide whether a row is fit to ship; this converts the cited
// weight to integer milligrams (specToMg, the same parser the editor uses) and sorts.

import { CATALOG_CSV_HEADERS, serializeCsv, specToMg } from "./catalogCsv";
import { extractAttributes, serializeAttributes } from "./catalogAttributes";
import type { Finding } from "./catalogChecks";
import { researchGearType, type ResearchFile } from "./research";
import { runResearchChecks } from "./researchChecks";
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
  /** What the research checks refuse: while there is any, nothing builds. */
  errors: Finding[];
  /** The CSV's rows, sorted. */
  rows: BuiltRow[];
  /** Research rows carrying attributes their variant doesn't state. */
  handWritten: number;
}

export function buildCatalog(files: readonly ResearchFile[]): CatalogBuild {
  // Every rule a row is held to lives in the research checks, so the build doesn't restate
  // them: a refused row stops the whole build instead of the CSV quietly losing it.
  const errors = runResearchChecks(files).filter((f) => f.level === "error");
  if (errors.length) return { errors, rows: [], handWritten: 0 };

  const built: BuiltRow[] = [];
  let handWritten = 0; // research rows carrying attributes their variant doesn't state
  for (const { rows } of files) {
    for (const row of rows) {
      const variant = normalizeVariant(row.variant ?? "");
      const category = row.category_hint ?? "";
      const common_name = researchGearType(row);
      built.push({
        brand: (row.brand ?? "").trim(),
        name: (row.name ?? "").trim(),
        common_name,
        variant,
        // The row's axes: what its variant states, read mechanically once the gear type is
        // known ("Regular" is a length on a quilt and a torso on a pack), plus what research
        // wrote by hand. A hand-written value that contradicts the variant fails the CSV
        // check (attr-mismatch); the reader itself never emits a value the checks refuse.
        attributes: serializeAttributes({ ...extractAttributes(variant, common_name, category), ...(row.attributes ?? {}) }),
        attributes_unpublished: (row.attributes_unpublished ?? []).join("; "),
        category_hint: category,
        weight_mg: specToMg(Number(row.weight_value), (row.weight_unit ?? "").trim() as Unit, row.weight_secondary),
        weight_source: row.weight_source ?? "",
        source_url: (row.source_url ?? "").trim(),
        kcal: row.kcal ?? null,
      });
      if (row.attributes && Object.keys(row.attributes).length) handWritten++;
    }
  }

  built.sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category_hint) - CATEGORY_ORDER.indexOf(b.category_hint) ||
      a.brand.localeCompare(b.brand) ||
      a.name.localeCompare(b.name) ||
      a.variant.localeCompare(b.variant),
  );

  return { errors, rows: built, handWritten };
}

/** The CSV text for a build's rows, byte for byte what seed/catalog.csv holds. */
export const catalogCsvText = (rows: BuiltRow[]): string => serializeCsv(CATALOG_CSV_HEADERS, rows);
