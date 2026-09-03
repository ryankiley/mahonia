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

/** Every accepted unit word (incl. plurals / full names) → canonical Unit. The single
 *  source of truth for unit vocabulary, shared by free-text weight parsing and the
 *  CSV / LighterPack importer so both recognize the same words. */
export const UNIT_ALIASES: Record<string, Unit> = {
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

// The input scanner both parsers below share: a number (digits with any mix of
// ',' / '.' separators), optionally followed by a unit word. One definition so
// parseWeightInput and entryUnitFromInput can never disagree about what counts
// as a token; a fresh regex per call because /g carries lastIndex state.
const weightScan = () => /(-?[\d][\d.,]*)\s*([a-z]+)?/g;

export function parseWeightInput(
  raw: string,
  defaultUnit: Unit = "g",
): number | null {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;

  // numFromGroup() below decides which separator is the decimal point
  const re = weightScan();
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

/**
 * Which unit did the typist actually NAME? Companion to parseWeightInput, which
 * answers "how much" and deliberately throws this away.
 *
 * Returns a unit only when the input names EXACTLY ONE. Three cases, three answers:
 *  • "3.8 oz"        → "oz"  — an explicit choice; the row should read back in it
 *  • "820"           → null  — no choice made, so the list's own unit applies
 *  • "2 lb 3 oz"     → null  — a compound has no single unit to read back in, and
 *                              its sum is the point; forcing one would misreport
 *                              the entry as much as picking the wrong one
 *
 * Null therefore means "no opinion", never "invalid" — callers fall back to the
 * list's displayUnit, which is what every row did before entryUnit existed.
 */
export function entryUnitFromInput(raw: string): Unit | null {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  const seen = new Set<Unit>();
  const re = weightScan();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const word = m[2];
    if (!word) continue;
    const unit = UNIT_ALIASES[word];
    if (unit) seen.add(unit);
  }
  return seen.size === 1 ? [...seen][0]! : null;
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

/**
 * A row's GROUP line weight for DISPLAY: the item's own line plus its children's lines.
 * Totals never use this (they sum each item's OWN line, so a parent + its kids aren't
 * double-counted) — it's what a parent row shows in its weight column and what a folder
 * subtotal rolls up per top-level row.
 */
export function groupLineMg(item: Item, items: readonly Item[]): number {
  let mg = lineMg(item);
  for (const child of items) if (child.parentId === item.id) mg += lineMg(child);
  return mg;
}

/**
 * What a row's weight column shows: a group's total (own + children) for a parent,
 * its own line for a leaf. The one rule the editor's ItemRow and the share views'
 * ReadonlyItemRow both render, so they can't drift. `children` is this row's own
 * children (already filtered), so the group sum is O(children).
 */
export function rowDisplayMg(item: Item, children: readonly Item[]): number {
  // groupLineMg over zero children IS the own-line case — no branch needed
  return groupLineMg(item, children);
}

/** Units of a line that count as worn via the wornQty split.
 *  0 when the split doesn't apply (no wornQty, or effective class ≠ base). */
export function splitWornQty(
  item: Pick<Item, "qty" | "wornQty">,
  cls: Classification,
): number {
  if (cls !== "base" || item.wornQty == null) return 0;
  return Math.max(0, Math.min(Math.round(item.wornQty), Math.max(0, item.qty)));
}

/** Items sharing a "container" — the same folder AND the same parent (null = top-level).
 *  This is the sibling set an item reorders within, and where a new sibling appends. */
export function siblingItems<T extends { folderId: string | null; parentId?: string | null }>(
  items: readonly T[],
  folderId: string | null,
  parentId: string | null = null,
): T[] {
  return items.filter((i) => i.folderId === folderId && (i.parentId ?? null) === parentId);
}

/** Top-level rows with no folder — the "Ungrouped" section the editor and the read
 *  views both render (nested children render under their parent, so a change to the
 *  nesting rules has one predicate to touch). */
export function ungroupedTopLevel<T extends { folderId: string | null; parentId?: string | null }>(
  items: readonly T[],
): T[] {
  return siblingItems(items, null);
}

/**
 * sortOrder that appends a new item at the BOTTOM of its container (folder + parent):
 * max existing sibling sortOrder + 1, not the count. Deletes and drag-outs leave holes
 * (only a move's TARGET container gets reindexed), so a count-based value can land mid-list.
 */
export function nextSortOrder<T extends { folderId: string | null; parentId?: string | null; sortOrder: number }>(
  items: readonly T[],
  folderId: string | null,
  parentId: string | null = null,
): number {
  const sibs = siblingItems(items, folderId, parentId);
  return sibs.length ? Math.max(...sibs.map((i) => i.sortOrder)) + 1 : 0;
}

/** A folder's TOP-LEVEL items in drag order (nested children render under their
 *  parent, so they're excluded here). Shared by the exporters so every surface
 *  (editor, share views, Markdown/CSV) orders a folder identically. */
export function sortedFolderItems(items: readonly Item[], folder: Folder): Item[] {
  return items.filter((i) => i.folderId === folder.id && i.parentId == null).sort(bySortOrder);
}

/**
 * Group TOP-LEVEL items by folder id (ungrouped + nested children excluded), each group
 * in drag order (sortOrder). One O(items) pass, built once per snapshot — so per-folder
 * consumers (one FolderSection per folder) don't each re-filter and re-sort the whole
 * item array on every edit. Children are rendered by their parent row (via
 * groupItemsByParent), not as folder rows.
 */
export function groupItemsByFolder(items: readonly Item[]): Map<string, Item[]> {
  const byFolder = new Map<string, Item[]>();
  for (const item of items) {
    if (item.folderId == null || item.parentId != null) continue; // top-level only
    const group = byFolder.get(item.folderId);
    if (group) group.push(item);
    else byFolder.set(item.folderId, [item]);
  }
  for (const group of byFolder.values()) group.sort(bySortOrder);
  return byFolder;
}

/**
 * Group nested children by their parent id, each group in sortOrder. One
 * O(items) pass, built once per snapshot at the view root and
 * threaded to the rows — so each row doesn't re-scan the whole item array for its
 * children on every render (O(rows × items) across a list).
 */
export function groupItemsByParent<T extends { parentId?: string | null; sortOrder: number }>(
  items: readonly T[],
): Map<string, T[]> {
  const byParent = new Map<string, T[]>();
  for (const item of items) {
    if (item.parentId == null) continue;
    const group = byParent.get(item.parentId);
    if (group) group.push(item);
    else byParent.set(item.parentId, [item]);
  }
  for (const group of byParent.values()) group.sort(bySortOrder);
  return byParent;
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
 * Is `carriedMg` worth showing, or would it just restate a figure already on screen?
 *
 * With nothing worn, carried IS the total; with no consumables, it IS base. It earns
 * its place only when both are present — which is also the only time the arithmetic
 * was annoying enough to want it done for you.
 *
 * Lives here, not in the surfaces: it's a judgment about the data, and it had been
 * written out longhand in both TotalsBar and the Markdown exporter, where a third
 * consumer could have got it subtly different with nothing to catch it.
 */
export const carriedIsDistinct = (t: Totals): boolean => t.wornMg > 0 && t.consumableMg > 0;

/**
 * The classification breakdown, in fixed order, with the judgment calls applied:
 * only categories that carry weight show (no "Consumable 0 g" noise), and a lone
 * "Base" chip is dropped — it would equal the headline total and just restate it,
 * since base is the default class and "it's all base" is the null result. A lone
 * WORN or CONSUMABLE chip is kept: that one IS a fact the headline doesn't carry
 * (nothing here counts toward base weight).
 *
 * Lives here for the same reason as carriedIsDistinct above: it's a judgment
 * about the data, and it has two renderers (TotalsBar and the social-card image)
 * that must agree on it.
 */
export function totalsChips(t: Totals): { label: "Base" | "Worn" | "Consumable"; mg: number }[] {
  const present = [
    { label: "Base" as const, mg: t.baseMg },
    { label: "Worn" as const, mg: t.wornMg },
    { label: "Consumable" as const, mg: t.consumableMg },
  ].filter((c) => c.mg > 0);
  if (present.length === 1 && present[0]!.label === "Base") return [];
  return present;
}

/**
 * Compute the rollups. base = total − worn − consumable; carried = total − worn
 * (i.e. base + consumable — everything in the pack, nothing on your body).
 * The math keys off effective classification, never folder names, so lists
 * stay comparable no matter how each person folders.
 */
export function computeTotals(list: ListData): Totals {
  let totalMg = 0;
  let wornMg = 0;
  let consumableMg = 0;
  let hasWeights = false;
  let kcalTotal = 0;
  let hasKcal = false;

  // one lookup table instead of a folders.find() per item — keeps the rollup
  // O(items + folders) (it recomputes on every edit)
  // Every item — top-level OR nested — is counted ONCE by its own effective class and
  // own line weight. A nested child carries its own weight/class/folder (it shares its
  // parent's folder), and a parent container's own weight is usually 0, so summing every
  // item is exactly total = Σ(all lines) with no parent/child double-count.
  const folderById = new Map(list.folders.map((f) => [f.id, f]));
  for (const item of list.items) {
    const line = lineMg(item);
    if (item.unitWeightMg > 0) hasWeights = true;
    totalMg += line;
    const cls =
      item.classification ??
      (item.folderId ? folderById.get(item.folderId)?.defaultClassification : undefined) ??
      "base";
    if (cls === "worn") wornMg += line;
    else if (cls === "consumable") {
      consumableMg += line;
      // gated on the EFFECTIVE class, the same condition that makes the field
      // reachable in the editor — so what's counted is exactly what's editable
      // (see Item.kcal). A kcal left behind on a row since demoted to base is
      // carried in the data but contributes nothing until it's consumable again.
      if (item.kcal != null && item.kcal > 0) {
        hasKcal = true;
        kcalTotal += item.kcal * Math.max(0, item.qty);
      }
    } else {
      // a base line can carry a worn split (e.g. 3 pairs of socks, 1 worn) —
      // move that portion into worn; the remainder stays in the derived base
      const wq = splitWornQty(item, cls);
      if (wq > 0) wornMg += wq * Math.max(0, item.unitWeightMg);
    }
  }

  return {
    totalMg,
    wornMg,
    consumableMg,
    baseMg: totalMg - wornMg - consumableMg,
    // derived off worn rather than re-adding base + consumable, so it can't drift
    // from the two lines above by a rounding path of its own
    carriedMg: totalMg - wornMg,
    itemCount: list.items.length,
    hasWeights,
    kcalTotal,
    hasKcal,
  };
}

// Number formatting is PINNED to one locale, never the ambient default.
// `toLocaleString(undefined, …)` resolves to the render lambda's locale on the
// server and the visitor's in the browser, and the read-only share views
// (/l/{slug}, /s/{code}) render weights server-side — so a visitor whose browser
// says de-DE would hydrate "1.235" over an SSR'd "1,235" (and "1,5 kg" over
// "1.5 kg"), a mismatch Vue silently patches after paint. Those pages are also
// edge-cached, so the HTML every visitor gets carries whichever locale the lambda
// happened to have. Pinning makes the two sides agree by construction. This is the
// same rule the date formatters already follow — see app/pages/about.vue and
// app/pages/changes.vue, which pin for exactly this reason.
const NUM_LOCALE = "en-US";

/**
 * Format milligrams for display in `unit`. STRICT: the selected unit is always
 * the unit shown — grams stay grams, kg stays kg (no auto g→kg / oz→lb promotion).
 *
 * A real (non-zero) weight that would round to zero in a coarse unit — a 2 g brush
 * shown in lb — must NOT read as "0"; that's just wrong. Instead we show it as
 * "less than the smallest step the unit resolves" ("<0.01 lb", "<0.1 oz", "<1 g"),
 * so a tiny item reads as present-but-small. Pass `raw: true` to opt out: editable
 * weight fields need a bare, parseable number (and a genuine 0 stays "0").
 */
export function formatWeight(
  mg: number,
  unit: Unit,
  opts: { withUnit?: boolean; raw?: boolean } = {},
): string {
  const { withUnit = true, raw = false } = opts;
  const value = fromMg(mg, unit);
  const decimals = unit === "g" ? 0 : unit === "kg" ? 2 : unit === "oz" ? 1 : 2;
  const step = 10 ** -decimals; // smallest value this unit shows: 1 g, 0.1 oz, 0.01 lb/kg
  if (!raw && mg > 0 && Math.round(value / step) === 0) {
    const stepStr = step.toLocaleString(NUM_LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return withUnit ? `<${stepStr} ${unit}` : `<${stepStr}`;
  }
  const num = value.toLocaleString(NUM_LOCALE, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
  return withUnit ? `${num} ${unit}` : num;
}

/**
 * Format a calorie count. Lives here rather than in the component so it inherits
 * NUM_LOCALE — kcal renders on the read-only share views too, and an ambient locale
 * would give it the same SSR/hydration mismatch the note above describes.
 *
 * Whole numbers only: kcal is never meaningfully fractional, and the underlying
 * field is already clamped to an integer.
 */
export function formatKcal(kcal: number): string {
  return Math.round(kcal).toLocaleString(NUM_LOCALE, { maximumFractionDigits: 0 });
}

/**
 * Pick a display unit by magnitude, then format — for comparison and marketing
 * surfaces (SEO/OG meta, feed cards) where "5 kg" reads better than "5,000 g".
 * Metric promotes g→kg at ≥1 kg; imperial promotes oz→lb at ≥1 lb. This is the
 * magnitude auto-promotion that `formatWeight` deliberately dropped.
 */
export function formatWeightAuto(
  mg: number,
  opts: { system?: WeightSystem; withUnit?: boolean } = {},
): string {
  const { system = "metric", withUnit = true } = opts;
  return formatWeight(mg, autoUnit(mg, system), { withUnit });
}

export type WeightSystem = "metric" | "imperial";

/** The measurement system a display unit belongs to — so a surface that only knows
 *  the list's displayUnit (the social card, the vault's first-visit default, the
 *  text exporter) classifies it one way. Absent means metric, matching
 *  formatWeightAuto's own default. */
export const unitSystem = (unit: Unit | undefined): WeightSystem =>
  unit === "oz" || unit === "lb" ? "imperial" : "metric";

/** The unit formatWeightAuto's magnitude promotion picks — exported so a surface
 *  that renders the number and its unit as separate elements (the social card's
 *  big figure) promotes on exactly the same threshold. No default system: every
 *  caller has already chosen one (the "metric unless told otherwise" decision
 *  lives in formatWeightAuto and unitSystem, not here). */
export function autoUnit(mg: number, system: WeightSystem): Unit {
  if (system === "imperial") return mg >= MG_PER_UNIT.lb ? "lb" : "oz";
  return mg >= MG_PER_UNIT.kg ? "kg" : "g";
}
