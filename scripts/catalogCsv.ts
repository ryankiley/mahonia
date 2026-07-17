// Pure, side-effect-free helpers for the catalog seed pipeline: CSV parse/emit
// and cited-spec → integer-milligram conversion. No DB, no fs — so tests import
// these directly (tests/catalog.test.ts) and the build/seed scripts reuse them.

import { MG_PER_UNIT, parseWeightInput } from "../shared/weights";
import { buildSearchTerms } from "../shared/searchTerms";

export type SpecUnit = "g" | "kg" | "oz" | "lb";

export const CATALOG_CSV_HEADERS = [
  "brand",
  "name",
  "variant",
  "category_hint",
  "weight_mg",
  "weight_source",
  "source_url",
] as const;

export const WEIGHT_SOURCES = [
  "manufacturer",
  "measured",
  "community",
  "imported",
] as const;

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
export function csvEscape(field: string): string {
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

/**
 * Parse CSV text into rows of string fields. Handles double-quoted fields with
 * embedded commas, newlines, and "" escapes. Tolerates \r\n and a trailing
 * newline. Hand-rolled (no deps) — small and predictable.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
    } else if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      endField();
      i++;
    } else if (c === "\n") {
      endRow();
      i++;
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  // flush the last field/row unless the input ended exactly on a newline
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

export interface CatalogCsvRow {
  brand: string | null;
  name: string;
  variant: string | null;
  categoryHint: string | null;
  weightMg: number;
  weightSource: string;
  sourceUrl: string | null;
  // Derived (not a CSV column): the extra words this row is searchable by —
  // category noun + locale/synonym aliases. See shared/searchTerms.ts.
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
  const iVariant = idx("variant");
  const iCat = idx("category_hint");
  const iMg = idx("weight_mg");
  const iSrc = idx("weight_source");
  const iUrl = idx("source_url");
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
    if (!(WEIGHT_SOURCES as readonly string[]).includes(weightSource)) {
      throw new Error(`row ${r + 1} (${name}): invalid weight_source "${weightSource}"`);
    }
    const blankToNull = (v: string | undefined) => {
      const t = (v ?? "").trim();
      return t === "" ? null : t;
    };
    const categoryHint = iCat >= 0 ? blankToNull(cells[iCat]) : null;
    out.push({
      brand: iBrand >= 0 ? blankToNull(cells[iBrand]) : null,
      name,
      variant: iVariant >= 0 ? blankToNull(cells[iVariant]) : null,
      categoryHint,
      weightMg,
      weightSource,
      sourceUrl: iUrl >= 0 ? blankToNull(cells[iUrl]) : null,
      searchTerms: buildSearchTerms(name, categoryHint),
    });
  }
  return out;
}
