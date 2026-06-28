// Weight math — the single source of truth for unit conversion and totals.
// All weights are stored as INTEGER MILLIGRAMS to avoid float drift across
// many items and oz<->g conversions. Display unit is presentation only.

import type {
  Classification,
  Folder,
  Item,
  ListData,
  Totals,
  Unit,
} from "./types";

/** Milligrams per one display unit. */
export const MG_PER_UNIT: Record<Unit, number> = {
  g: 1_000,
  kg: 1_000_000,
  oz: 28_349.523125,
  lb: 453_592.37,
};

/** A display value in `unit` -> integer milligrams. */
export function toMg(value: number, unit: Unit): number {
  return Math.round(value * MG_PER_UNIT[unit]);
}

/** Integer milligrams -> a (lossy) display value in `unit`. */
export function fromMg(mg: number, unit: Unit): number {
  return mg / MG_PER_UNIT[unit];
}

const UNIT_ALIASES: Record<string, Unit> = {
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kgs: "kg",
  kilogram: "kg",
  kilograms: "kg",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
};

/**
 * Parse messy human weight input into integer milligrams.
 * Handles "1.36kg", "48 oz", "2 lb 3 oz", "820g", "1,360 g".
 * A bare number with no unit uses `defaultUnit`. Returns null if nothing parses.
 */
// Parse one captured number group, disambiguating ',' vs '.' as decimal point so
// "1,5 kg" (comma-decimal locales) reads as 1.5, not 15. Rules:
//  - both separators present → the RIGHTMOST one is the decimal point
//  - only commas, single comma + 1–2 trailing digits → decimal (else thousands)
//  - only dots → standard decimal
function numFromGroup(s: string): number {
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let norm = s;
  if (hasComma && hasDot) {
    norm =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".") // 1.234,56 → 1234.56
        : s.replace(/,/g, ""); // 1,234.56 → 1234.56
  } else if (hasComma) {
    norm = /^-?\d+,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  return parseFloat(norm);
}

export function parseWeightInput(
  raw: string,
  defaultUnit: Unit = "g",
): number | null {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;

  // number (digits with any mix of ',' / '.' separators), optionally + a unit word;
  // numFromGroup() below decides which separator is the decimal point
  const re = /(-?[\d][\d.,]*)\s*([a-z]+)?/g;
  let mg = 0;
  let matched = false;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const num = numFromGroup(m[1]!);
    if (!isFinite(num)) continue;
    const unitWord = m[2];
    const unit = unitWord ? UNIT_ALIASES[unitWord] : defaultUnit;
    if (!unit) continue; // an unknown word like "stuff sack" — skip
    matched = true;
    mg += num * MG_PER_UNIT[unit];
  }

  return matched ? Math.round(mg) : null;
}

/** An item's effective classification = its own, else its folder's default. */
export function effectiveClassification(
  item: Pick<Item, "classification" | "folderId">,
  folders: Folder[],
): Classification {
  if (item.classification) return item.classification;
  const folder = folders.find((f) => f.id === item.folderId);
  return folder?.defaultClassification ?? "base";
}

/** Line weight for an item (qty × unit weight), in milligrams. */
export function lineMg(item: Pick<Item, "qty" | "unitWeightMg">): number {
  return Math.max(0, item.qty) * Math.max(0, item.unitWeightMg);
}

/** Items belonging to a folder (or null = ungrouped), in array order. */
export function itemsInFolder<T extends { folderId: string | null }>(
  items: readonly T[],
  folderId: string | null,
): T[] {
  return items.filter((i) => i.folderId === folderId);
}

/** Sort comparator for anything with a sortOrder (items + folders). */
export const bySortOrder = (a: { sortOrder: number }, b: { sortOrder: number }): number =>
  a.sortOrder - b.sortOrder;

/** Flat display name "Brand Name Variant" (brand/variant optional) — shared by
 *  exports + the editable name field. Two-arg calls (e.g. catalog search text)
 *  keep the old "Brand Name" behavior since variant defaults to undefined. */
export const itemDisplayName = (
  brand: string | null | undefined,
  name: string,
  variant?: string | null,
): string => [brand, name, variant].filter(Boolean).join(" ");

/**
 * Compute the four rollups. base = total − worn − consumable.
 * The math keys off effective classification, never folder names, so lists
 * stay comparable no matter how each person folders.
 */
export function computeTotals(list: ListData): Totals {
  let totalMg = 0;
  let wornMg = 0;
  let consumableMg = 0;
  let hasWeights = false;

  for (const item of list.items) {
    const line = lineMg(item);
    if (item.unitWeightMg > 0) hasWeights = true;
    totalMg += line;
    const cls = effectiveClassification(item, list.folders);
    if (cls === "worn") wornMg += line;
    else if (cls === "consumable") consumableMg += line;
  }

  return {
    totalMg,
    wornMg,
    consumableMg,
    baseMg: totalMg - wornMg - consumableMg,
    itemCount: list.items.length,
    hasWeights,
  };
}

/**
 * Format milligrams for display in `unit`. STRICT: the selected unit is always
 * the unit shown — grams stay grams, kg stays kg (no auto g→kg / oz→lb promotion).
 */
export function formatWeight(
  mg: number,
  unit: Unit,
  opts: { withUnit?: boolean } = {},
): string {
  const { withUnit = true } = opts;
  const value = fromMg(mg, unit);
  const decimals = unit === "g" ? 0 : unit === "kg" ? 2 : unit === "oz" ? 1 : 2;
  const num = value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  return withUnit ? `${num} ${unit}` : num;
}

/**
 * Pick a display unit by magnitude, then format — for comparison and marketing
 * surfaces (SEO/OG meta, feed cards) where "5 kg" reads better than "5,000 g".
 * Metric promotes g→kg at ≥1 kg; imperial promotes oz→lb at ≥1 lb. This is the
 * magnitude auto-promotion that `formatWeight` deliberately dropped.
 */
export function formatWeightAuto(
  mg: number,
  opts: { system?: "metric" | "imperial"; withUnit?: boolean } = {},
): string {
  const { system = "metric", withUnit = true } = opts;
  const unit: Unit =
    system === "imperial"
      ? mg >= MG_PER_UNIT.lb
        ? "lb"
        : "oz"
      : mg >= MG_PER_UNIT.kg
        ? "kg"
        : "g";
  return formatWeight(mg, unit, { withUnit });
}
