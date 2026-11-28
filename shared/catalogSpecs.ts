// A piece of gear's SPECS, as one short line: "20°F · 900 fill" under a quilt, "R 4.5"
// under a pad, "2P", "40 L", "10,000 mAh". Read from its catalog row's typed axes (the
// CSV's `attributes` cell, carried into catalog_items.attributes), so My Gear shows what
// the catalog knows about a linked piece without anyone typing it.
//
// Only the axes that describe the gear, not the ones that pick a size: fit, size, torso,
// length and width are what the piece's own variant already says ("Women's Medium",
// "Regular Wide"), and a spec that the name or variant states in the maker's own words
// ("20F, 950FP, Regular", "Arc Haul Ultra 40L") is left out too, so nothing reads twice
// on the row.

import type { Unit } from "./types";
import { unitSystem } from "./weights";

/** The axes a spec line shows, in the order it shows them. */
const SPEC_KEYS = [
  "temp_f",
  "fill_power",
  "insulation_gsm",
  "r_value",
  "persons",
  "volume_l",
  "capacity_mah",
  "lumens",
  "fuel_g",
  "fuel",
] as const;
type SpecKey = (typeof SPEC_KEYS)[number];

/** "length=Regular; temp_f=20" as a map. Lenient: the cell is written by the build, which
 *  holds it to one form, so a part that doesn't parse is skipped rather than an error. */
export function parseAttributeCell(cell: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (cell ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the variant already state this value, in the catalog's own spelling of it? */
function stated(key: SpecKey, value: string, variant: string): boolean {
  if (!variant) return false;
  const v = esc(value);
  const test = (re: string) => new RegExp(re, "i").test(variant);
  switch (key) {
    case "temp_f":
      return test(`(^|[^\\d])${v}\\s?°?F\\b`);
    case "fill_power":
      return test(`(^|[^\\d])${v}\\+?\\s?FP\\b`);
    case "insulation_gsm":
      return test(`(^|[^\\d])${v}\\s?gsm\\b`) || test(`\\bAPEX\\s?${v}\\b`);
    case "r_value":
      return test(`\\bR-?\\s?${v}\\b`);
    case "persons":
      return test(`(^|[^\\d])${v}\\s?P\\b`);
    case "volume_l": {
      const ml = String(Math.round(Number(value) * 1000));
      return test(`(^|[^\\d.])${v}\\s?L\\b`) || test(`(^|[^\\d])${ml}\\s?ml\\b`);
    }
    case "capacity_mah":
      return test(`(^|[^\\d])${v}\\s?mAh\\b`);
    case "lumens":
      return test(`(^|[^\\d])${v}\\s?(?:lumens?|lm)\\b`);
    case "fuel_g":
      return test(`(^|[^\\d])${v}\\s?g\\b`);
    case "fuel":
      return test(`\\b${v}\\b`);
  }
}

function format(key: SpecKey, value: string, unit: Unit): string | null {
  const n = Number(value);
  switch (key) {
    case "temp_f":
      if (!Number.isFinite(n)) return null;
      return unitSystem(unit) === "metric" ? `${Math.round(((n - 32) * 5) / 9)}°C` : `${n}°F`;
    case "fill_power":
      return Number.isFinite(n) ? `${n} fill` : null;
    case "insulation_gsm":
      return Number.isFinite(n) ? `${n} gsm` : null;
    case "r_value":
      return Number.isFinite(n) ? `R ${n}` : null;
    case "persons":
      return Number.isFinite(n) ? `${n}P` : null;
    case "volume_l":
      if (!Number.isFinite(n) || n <= 0) return null;
      return n < 1 ? `${Math.round(n * 1000)} ml` : `${n} L`;
    case "capacity_mah":
      return Number.isFinite(n) ? `${n.toLocaleString("en-US")} mAh` : null;
    case "lumens":
      return Number.isFinite(n) ? `${n.toLocaleString("en-US")} lumens` : null;
    case "fuel_g":
      return Number.isFinite(n) ? `${n} g of fuel` : null;
    case "fuel":
      return value || null;
  }
}

/**
 * The spec line's parts for a piece: its catalog row's attributes, minus what its own
 * name and variant already say (`said`: the text the row already shows), each in the
 * reader's units (a rating in °C for someone who reads in grams and kilograms, since that
 * is the scale the rest of their page is in).
 */
export function specParts(cell: string | null | undefined, said: string | null | undefined, unit: Unit): string[] {
  const attrs = parseAttributeCell(cell);
  const out: string[] = [];
  for (const key of SPEC_KEYS) {
    const value = attrs.get(key);
    if (!value || stated(key, value, said ?? "")) continue;
    const text = format(key, value, unit);
    if (text) out.push(text);
  }
  return out;
}
