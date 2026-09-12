// Pure, side-effect-free helpers for the catalog seed pipeline: CSV parse/emit
// and cited-spec → integer-milligram conversion. No DB, no fs — so tests import
// these directly (tests/catalog.test.ts) and the build/seed scripts reuse them.

import { parseCsv } from "../shared/exporters/csv";
import { WEIGHT_SOURCES, type WeightSource } from "../shared/types";
import { MG_PER_UNIT, parseWeightInput } from "../shared/weights";
import { ATTRIBUTE_KEYS, parseAttributes, type AttributeKey, type RowAttributes } from "./catalogAttributes";
import { buildSearchTerms } from "./searchTerms";

export type SpecUnit = "g" | "kg" | "oz" | "lb";

export const CATALOG_CSV_HEADERS = [
  "brand",
  "name",
  "common_name",
  "variant",
  // the variant's axes, typed: "temp_f=20; fill_power=950; length=Regular" (one cell,
  // no quoting — see scripts/catalogAttributes.ts). Beside the variant it types, ahead
  // of the weight/provenance triplet, which stays contiguous.
  "attributes",
  // axes the maker publishes no single value for, "size; fit", so the audit's to-do list
  // can tell "unresearched" from "researched, nothing to cite" (ResearchRow.attributes_unpublished)
  "attributes_unpublished",
  "category_hint",
  "weight_mg",
  "weight_source",
  "source_url",
  // per-unit food energy — food rows only, blank elsewhere. Last so the
  // weight/provenance triplet stays contiguous; blank rows just gain a comma.
  "kcal",
] as const;

export { WEIGHT_SOURCES };

/** Membership in the provenance enum — one test instead of a cast-and-includes
 *  at every call site (the parser, the builder, the auditor, the gating test). */
export const isWeightSource = (s: string): s is WeightSource =>
  (WEIGHT_SOURCES as readonly string[]).includes(s);

/** A usable citation: an absolute http(s) URL with a host. Keep this parsed rather
 * than regex-shaped: `https://#note` and `https://?q` look like they have text after
 * the scheme but have no destination for a reader or an audit to open. */
export const isCitationUrl = (s: string): boolean => {
  try {
    const url = new URL(s);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
};

/** The catalog identity join: brand|name|variant, lowercased. Pre-processing
 *  (variant normalization, null-folding) stays at each call site — the builder
 *  and the auditor deliberately feed it differently. */
export const identityKey = (brand: string, name: string, variant: string): string =>
  `${brand.toLowerCase()}|${name.toLowerCase()}|${variant.toLowerCase()}`;

/** "" (after trimming) → null, for the CSV's optional columns. */
const blankToNull = (v: string | undefined) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Convert a manufacturer's cited spec weight to integer milligrams.
 *
 * `value`+`unit` is the primary cited figure (e.g. 19.4 "oz"). `secondary` is an
 * optional second term and comes in TWO flavors that must not be conflated:
 *   • ADDITIVE remainder — "1 lb 13 oz" (value=1, unit="lb", secondary="13 oz").
 *     The total is primary + secondary.
 *   • REDUNDANT equivalent — the same mass restated in another unit, e.g.
 *     value=29.7 "oz", secondary="841.7 g", or value=4.613 "lb", secondary=
 *     "2.092 kg". Here secondary must be IGNORED, not added (adding doubles it).
 *
 * We disambiguate by magnitude: an oz/g remainder of a lb/kg primary is always
 * ≥6% different from the primary (15 oz is the largest possible oz remainder,
 * 6.25% below 1 lb), whereas a restated equivalent is the same mass (<5%). So a
 * secondary within 5% of the primary is treated as redundant and dropped.
 */
// unit size order (by mass): g < oz < lb < kg
const UNIT_RANK: Record<SpecUnit, number> = { g: 0, oz: 1, lb: 2, kg: 3 };

const SECONDARY_UNIT_RE =
  /\b(kg|kgs?|kilograms?|lb|lbs?|pounds?|oz|ounces?|g|grams?)\b/i;
function secondaryUnit(s: string): SpecUnit | null {
  const m = s.match(SECONDARY_UNIT_RE);
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (w.startsWith("k")) return "kg";
  if (w.startsWith("l") || w.startsWith("p")) return "lb";
  if (w.startsWith("o")) return "oz";
  return "g";
}

export function specToMg(
  value: number,
  unit: SpecUnit,
  secondary?: string | null,
): number {
  if (!Number.isFinite(value)) throw new Error(`bad weight value: ${value}`);
  if (!(unit in MG_PER_UNIT)) throw new Error(`bad weight unit: ${unit}`);
  const primaryMg = Math.round(value * MG_PER_UNIT[unit]);

  const sec = secondary?.trim();
  if (sec) {
    // A genuine ADDITIVE remainder ("1 lb 13 oz") has EXACTLY ONE number and a
    // unit strictly smaller than the primary, and is materially smaller than the
    // primary. Anything else (a restated equivalent like "841.7 g" / "0.06 kg",
    // or a messy multi-figure restatement like "2 lb 1 oz | 940 g") is REDUNDANT
    // and must be ignored — adding it would double-count the weight.
    const numberCount = (sec.match(/\d+(?:\.\d+)?/g) || []).length;
    const secUnit = secondaryUnit(sec);
    const secMg = parseWeightInput(sec, unit);
    const isAdditive =
      numberCount === 1 &&
      secUnit != null &&
      UNIT_RANK[secUnit] < UNIT_RANK[unit] &&
      secMg != null &&
      secMg > 0 &&
      secMg < primaryMg &&
      Math.abs(primaryMg - secMg) / primaryMg >= 0.05;
    if (isAdditive) return primaryMg + (secMg as number);
    // else: redundant — fall through to the primary
  }

  if (primaryMg <= 0) throw new Error(`could not parse spec: "${value} ${unit}"`);
  return primaryMg;
}

// --- CSV (RFC 4180-ish): quoted fields, "" escapes, commas/newlines in quotes -

/** Quote a field iff it contains a comma, quote, or newline; double inner quotes. */
function csvEscape(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** Serialize a header row + records (array-of-objects keyed by header) to CSV. */
export function serializeCsv(
  headers: readonly string[],
  records: Array<Record<string, string | number | null | undefined>>,
): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const rec of records) {
    lines.push(
      headers
        .map((h) => csvEscape(rec[h] == null ? "" : String(rec[h])))
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export interface CatalogCsvRow {
  brand: string | null;
  name: string;
  // Generated default common name (a CSV column, unlike searchTerms which is derived);
  // sourced from seed/common-names.json at build time. See scripts/build-catalog.ts.
  commonName: string | null;
  variant: string | null;
  // The variant's axes as data (fit, size, temp_f, volume_l, …); null when the row
  // states none. Parsed strictly: a cell the checks would reject never loads.
  attributes: RowAttributes | null;
  // Axes researched and found unpublished by the maker; the attr-gap warning skips them.
  attributesUnpublished: AttributeKey[];
  categoryHint: string | null;
  weightMg: number;
  // Per-unit food energy (kcal) from the cited research — food rows only. The
  // kcal citation itself lives on the research row (kcal_source_url/kcal_quote),
  // not in the CSV: source_url stays the weight's provenance.
  kcal: number | null;
  weightSource: string;
  sourceUrl: string | null;
  // Derived (not a CSV column): the extra words this row is searchable by —
  // category noun + locale/synonym aliases. See scripts/searchTerms.ts.
  searchTerms: string | null;
}

/** Map parsed CSV (with a header row) to typed catalog rows; validates required fields. */
export function csvToCatalogRows(text: string): CatalogCsvRow[] {
  const grid = parseCsv(text);
  if (grid.length === 0) return [];
  const header = grid[0].map((h) => h.trim());
  const idx = (col: string) => header.indexOf(col);
  const iBrand = idx("brand");
  const iName = idx("name");
  const iCommon = idx("common_name");
  const iVariant = idx("variant");
  const iCat = idx("category_hint");
  const iMg = idx("weight_mg");
  const iSrc = idx("weight_source");
  const iUrl = idx("source_url");
  const iKcal = idx("kcal");
  const iAttr = idx("attributes");
  const iUnpub = idx("attributes_unpublished");
  if (iName < 0 || iMg < 0 || iSrc < 0) {
    throw new Error("catalog.csv missing required columns (name, weight_mg, weight_source)");
  }

  const out: CatalogCsvRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    if (cells.length === 1 && cells[0].trim() === "") continue; // blank line
    const name = (cells[iName] ?? "").trim();
    if (!name) continue;
    const weightMg = Number((cells[iMg] ?? "").trim());
    if (!Number.isInteger(weightMg) || weightMg <= 0) {
      throw new Error(`row ${r + 1} (${name}): weight_mg must be a positive integer`);
    }
    const weightSource = (cells[iSrc] ?? "").trim();
    if (!isWeightSource(weightSource)) {
      throw new Error(`row ${r + 1} (${name}): invalid weight_source "${weightSource}"`);
    }
    const categoryHint = iCat >= 0 ? blankToNull(cells[iCat]) : null;
    const kcalRaw = iKcal >= 0 ? blankToNull(cells[iKcal]) : null;
    const kcal = kcalRaw === null ? null : Number(kcalRaw);
    if (kcal !== null && (!Number.isInteger(kcal) || kcal <= 0)) {
      throw new Error(`row ${r + 1} (${name}): kcal must be a positive integer when present`);
    }
    const commonName = iCommon >= 0 ? blankToNull(cells[iCommon]) : null;
    let attributes: RowAttributes | null = null;
    if (iAttr >= 0) {
      try {
        attributes = parseAttributes(cells[iAttr]);
      } catch (e) {
        throw new Error(`row ${r + 1} (${name}): ${(e as Error).message}`);
      }
    }
    const attributesUnpublished: AttributeKey[] = [];
    for (const k of (iUnpub >= 0 ? (cells[iUnpub] ?? "") : "").split(/;\s*/).filter(Boolean)) {
      if (!(ATTRIBUTE_KEYS as readonly string[]).includes(k)) throw new Error(`row ${r + 1} (${name}): attributes_unpublished "${k}" is not an axis`);
      attributesUnpublished.push(k as AttributeKey);
    }
    out.push({
      brand: iBrand >= 0 ? blankToNull(cells[iBrand]) : null,
      name,
      commonName,
      variant: iVariant >= 0 ? blankToNull(cells[iVariant]) : null,
      attributes,
      attributesUnpublished,
      categoryHint,
      weightMg,
      kcal,
      weightSource,
      sourceUrl: iUrl >= 0 ? blankToNull(cells[iUrl]) : null,
      searchTerms: buildSearchTerms(name, categoryHint, commonName),
    });
  }
  return out;
}
