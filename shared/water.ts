// Water — the one item whose weight is derived from a volume, not measured.
// Water is ~1 g/mL, so a volume in millilitres maps 1:1 to grams (×1000 = mg).
// This lets people add "1 L of water" and get 1 kg without doing the arithmetic.
// Water counts as a consumable (see Classification in types.ts), so it stays out
// of base weight.

import type { Classification } from "./types";
import { lineMg, splitWornQty } from "./weights";
import { splitAmount } from "./trailDistance";

/** Milligrams of water per millilitre (water ≈ 1 g/mL = 1000 mg/mL). */
const WATER_MG_PER_ML = 1000;

// millilitres per volume unit
const ML_PER_UNIT = {
  ml: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  floz: 29.5735, // US fluid ounce
} as const;

/**
 * Parse a human volume — "1 L", "500 ml", "1.5l", "32 fl oz", "0.75" — into
 * millilitres. A bare number is read as litres (the common case for water).
 * Returns null for anything unparseable or non-positive.
 */
export function parseVolumeMl(raw: string): number | null {
  const amt = splitAmount(raw);
  if (!amt) return null;
  const { n, unit: u } = amt;
  let perMl: number | undefined;
  if (u === "" || u === "l" || u === "ltr" || u.startsWith("liter") || u.startsWith("litre")) perMl = ML_PER_UNIT.l;
  else if (u === "ml" || u === "mls" || u.startsWith("milli")) perMl = ML_PER_UNIT.ml;
  else if (u === "cl" || u.startsWith("centi")) perMl = ML_PER_UNIT.cl;
  else if (u === "dl" || u.startsWith("deci")) perMl = ML_PER_UNIT.dl;
  // "oz" in a water context means fluid ounces
  else if (u === "floz" || u === "oz" || u === "ounce" || u === "ounces" || u === "flounce") perMl = ML_PER_UNIT.floz;
  else return null;
  return n * perMl;
}

/** Integer milligrams of water for a given volume in millilitres. */
export function waterMgFromMl(ml: number): number {
  return Math.round(ml * WATER_MG_PER_ML);
}

/** A tidy label for a volume in millilitres: "1.5 L", "500 mL", "946 mL". */
export function formatVolume(ml: number): string {
  if (ml >= 1000) {
    // up to 2 decimals, trailing zeros trimmed (1 L, 1.5 L, 1.25 L)
    return `${Number.parseFloat((ml / 1000).toFixed(2))} L`;
  }
  return `${Math.round(ml)} mL`;
}

/** Exact "water" only — so "Water filter" stays a normal item, not a litres row. */
export function isWaterName(name: string): boolean {
  return /^water$/i.test(name.trim());
}

/** A water row's volume in litres as the bare number its fields show ("1.75"), or "" at zero. */
export function waterLiters(unitWeightMg: number): string {
  const l = unitWeightMg / 1_000_000;
  return l > 0 ? String(Number(l.toFixed(2))) : "";
}

/**
 * The static (read-only + checklist) views' amount label: water's "amount" is its
 * volume in litres (matching the editable row's litres field), so it reads "2 L"
 * rather than a meaningless "×1"; everything else keeps its ×quantity. Pass the
 * row's effective classification to surface a worn split ("×3 · 1 worn").
 *
 * `hideSingle` blanks a plain "×1" — the read views take it, because a quantity of
 * one is the default and a column where nearly every cell says the same thing is a
 * column that has to be read past to find the rows that actually carry a count. A
 * split still speaks ("×3 · 1 worn"), and so does water.
 */
export function itemQtyLabel(
  item: { name: string; qty: number; unitWeightMg: number; wornQty?: number },
  cls?: Classification,
  opts?: { hideSingle?: boolean },
): string {
  // Water's amount is the LINE's volume — unit volume × qty, the same arithmetic the
  // weight beside it does. Reading the unit volume alone put "1 L" against "2,000 g"
  // on a two-bottle row: two figures for one line, disagreeing by a factor of the qty.
  if (isWaterName(item.name)) return `${waterLiters(lineMg(item)) || "0"} L`;
  const wq = cls ? splitWornQty(item, cls) : 0;
  if (wq > 0) return `×${item.qty} · ${wq} worn`;
  return opts?.hideSingle && item.qty === 1 ? "" : `×${item.qty}`;
}
