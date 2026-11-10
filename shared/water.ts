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

// millilitres per volume unit. Exported for the catalog's variant reader (a "16oz" jar,
// a "52qt" cooler); parseVolumeMl below reads the metric units and fluid ounces only.
export const ML_PER_UNIT = {
  ml: 1,
  cl: 10,
  dl: 100,
  l: 1000,
  floz: 29.5735, // US fluid ounce
  qt: 946.353, // US liquid quart
  gal: 3785.41, // US gallon
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

/**
 * Does this name read as water: the word "water" as its LAST word? "Water", "Drinking
 * water", "Spare water", "2 L water", and with nothing after it but a volume or a bracket,
 * set off the way a weight is: "Water 2 L", "Water - 750 ml", "Water (2 L)". Exact
 * "water" only used to be the rule, so a renamed row ("Drinking water") lost its litres
 * field and took a count again (Nov 2026).
 *
 * Never gear. Gear puts its noun AFTER the word, which is where this stops: "Water
 * filter", "Water bottle", "Water treatment drops" (no catalog name ends in "water", of
 * 3,974 when this was written). "Smartwater" and "Waterproof bag" aren't the word, and a
 * "for" before it names a thing for water, not water: "Bag for dirty water".
 *
 * By the name alone, because the name is what the person sees and edits: a hidden flag
 * would be one more figure a renamed row could carry where nobody can see it.
 */
export function isWaterName(name: string): boolean {
  const low = name.trim().toLowerCase();
  const at = low.lastIndexOf("water");
  if (at < 0) return false; // nearly every row, every render
  const before = low.slice(0, at);
  if (/[\p{L}\p{N}]$/u.test(before) || /\bfor\b/.test(before)) return false;
  const after = low.slice(at + 5).trim();
  if (!after || /^\([^()]*\)$/.test(after)) return true;
  return parseVolumeMl(after.replace(/^[-–—:,|]\s*/, "")) != null;
}

/** "water 2 L", "Drinking water - 750 ml", "Water (2 L)", "2 L water": a water line and
 *  its volume, as the name the row keeps and the volume in ml, or null when the text is
 *  not water with a volume (a bare "water" is the water row without one; "500 ml" alone
 *  names no water). The name is what's left once the volume is put aside, so a word
 *  before "water" survives: "Drinking water 2 L" is "Drinking water" at 2 L; with nothing
 *  else it's "Water". The name field's commit, its menu and the pasted line all read this,
 *  so all three make the same row. */
export function waterPhrase(text: string): { name: string; ml: number } | null {
  const t = text.trim();
  const low = t.toLowerCase();
  const at = low.lastIndexOf("water");
  if (at < 0) return null;
  const before = low.slice(0, at).trim();
  // set off the way a weight is ("Water - 2 L", "Water: 750 ml", "Water (2 L)")
  const after = low.slice(at + 5).trim().replace(/^[-–—:,|(]\s*/, "").replace(/\)$/, "").trim();
  // a volume after the word, or one standing before it ("2 L water"), never both
  const ml = after ? parseVolumeMl(after) : before ? parseVolumeMl(before) : null;
  if (ml == null) return null;
  const name = after ? t.slice(0, at + 5).trim() : "Water";
  // the rest must still read as water: "Water bottle 1L", "Smartwater 1L" and "Bag for
  // dirty water 2L" are gear with a size, not a volume of water
  if (!isWaterName(name)) return null;
  return { name: /^water$/i.test(name) ? "Water" : name, ml };
}

/** Just the volume waterPhrase reads, in ml. */
export function waterPhraseMl(text: string): number | null {
  return waterPhrase(text)?.ml ?? null;
}

/** What the name field's MENU offers as water, in ml: everything waterPhraseMl reads,
 *  plus the two things only a menu can offer, since neither is a line that says water
 *  with a volume: a bare "water" (a litre, to be corrected in the row) and a bare volume
 *  ("500 ml"). Null when the text is neither. */
export function waterMenuMl(text: string): number | null {
  // exact "water" here, not isWaterName: the menu's row renames the line to "Water", so
  // offering it on "Drinking water" would trade the name typed for a litre on Enter
  if (/^water$/i.test(text.trim())) return 1000;
  return waterPhraseMl(text) ?? parseVolumeMl(text.trim().toLowerCase());
}

/** A water weight as the bare number of litres its fields show ("1.75"), or "" at zero. */
export function waterLiters(mg: number): string {
  const l = mg / 1_000_000;
  return l > 0 ? String(Number(l.toFixed(2))) : "";
}

/** A water row's amount wherever a count would stand: its whole volume, "3 L". Water is
 *  a volume, not a count (foldWaterQty, shared/ops), so no view, export or tool prints
 *  "×1" or "1" beside it. Reads the LINE, so a row stored before the fold still says
 *  what it weighs. */
export function waterVolumeLabel(item: { qty: number; unitWeightMg: number }): string {
  return `${waterLiters(lineMg(item)) || "0"} L`;
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
 *
 * `group` blanks the label, and it OUTRANKS the water branch below. A parent's weight
 * column shows the group TOTAL — own line plus the children's — so the count that would
 * sit beside it multiplies a figure it is already inside; and on a bare group it
 * multiplies zero. The editor drops the whole cell there for the same reason; this is
 * that one rule in the label the static views share, so the checklist and the read row
 * can't drift.
 *
 * It is the CALLER that decides which rows qualify, via isBareGroup (shared/weights). A
 * group that carries a line of its own keeps its label — these views cannot heal what
 * they render, and a figure with no visible count beside it would be exactly the
 * unexplained multiplier the rule exists to remove.
 *
 * Water is below it, not above: a bare group's own volume is zero by definition, so
 * letting water win printed "0 L" against a group total of two full bottles — two
 * figures for one line, disagreeing, which is the very thing the water branch exists to
 * prevent. The editor keeps a water group's litres FIELD (it is the only editable figure
 * such a row has); this label is a different question, and the answer there is nothing.
 */
export function itemQtyLabel(
  item: { name: string; qty: number; unitWeightMg: number; wornQty?: number },
  cls?: Classification,
  opts?: { hideSingle?: boolean; group?: boolean },
): string {
  if (opts?.group) return "";
  // Water's amount is the LINE's volume — unit volume × qty, the same arithmetic the
  // weight beside it does. Reading the unit volume alone put "1 L" against "2,000 g"
  // on a two-bottle row: two figures for one line, disagreeing by a factor of the qty.
  if (isWaterName(item.name)) return waterVolumeLabel(item);
  const wq = cls ? splitWornQty(item, cls) : 0;
  if (wq > 0) return `×${item.qty} · ${wq} worn`;
  return opts?.hideSingle && item.qty === 1 ? "" : `×${item.qty}`;
}
