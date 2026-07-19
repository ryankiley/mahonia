// Weight math — the single source of truth for unit conversion and totals.
// All weights are stored as INTEGER MILLIGRAMS to avoid float drift across
// many items and oz<->g conversions. Display unit is presentation only.

import type {
  Classification,
  Folder,
  FolderSort,
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

/** An item's nested children (items nested directly under it), in sortOrder. */
export function childrenOf<T extends { parentId?: string | null; sortOrder: number }>(
  items: readonly T[],
  parentId: string,
): T[] {
  return items.filter((i) => i.parentId === parentId).sort(bySortOrder);
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
  return children.length > 0 ? groupLineMg(item, children) : lineMg(item);
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

/** Items belonging to a folder (or null = ungrouped), in array order. Includes nested
 *  children (they carry their parent's folderId) — callers that want only top-level rows
 *  pass parentId = null via siblingItems / groupItemsByFolder. */
export function itemsInFolder<T extends { folderId: string | null }>(
  items: readonly T[],
  folderId: string | null,
): T[] {
  return items.filter((i) => i.folderId === folderId);
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

/**
 * Compare two items within a folder for the given sort mode. "manual" (the default,
 * and any unknown mode) falls back to sortOrder — the drag order. "name" is a
 * locale A–Z on the flat display name; "heaviest"/"lightest" key off the LINE weight
 * (qty × unit), so a heavy single and a stack of light items rank by what they add to
 * the pack. Every mode breaks ties on sortOrder, so equal-weight/name runs keep their
 * manual order and the result is deterministic (a stable sort isn't guaranteed here).
 */
export function compareItemsBy(sortBy: FolderSort | undefined, a: Item, b: Item): number {
  switch (sortBy) {
    case "name":
      return (
        itemDisplayName(a.brand, a.name, a.variant).localeCompare(
          itemDisplayName(b.brand, b.name, b.variant),
          undefined,
          { sensitivity: "base", numeric: true },
        ) || a.sortOrder - b.sortOrder
      );
    case "heaviest":
      return lineMg(b) - lineMg(a) || a.sortOrder - b.sortOrder;
    case "lightest":
      return lineMg(a) - lineMg(b) || a.sortOrder - b.sortOrder;
    default:
      return a.sortOrder - b.sortOrder;
  }
}

/** A folder's TOP-LEVEL items in its chosen sort order (nested children render under
 *  their parent, so they're excluded here). Shared by the exporters so every surface
 *  (editor, share views, Markdown/CSV) orders a folder identically. */
export function sortedFolderItems(items: readonly Item[], folder: Folder): Item[] {
  return items
    .filter((i) => i.folderId === folder.id && i.parentId == null)
    .sort((a, b) => compareItemsBy(folder.sortBy, a, b));
}

/**
 * Group TOP-LEVEL items by folder id (ungrouped + nested children excluded), each group
 * ordered by its folder's `sortBy` (manual = sortOrder). One O(items) pass, built once
 * per snapshot — so per-folder consumers (one FolderSection per folder) don't each
 * re-filter and re-sort the whole item array on every edit. Children are rendered by
 * their parent row (via childrenOf), not as folder rows. Pass `folders` to honor
 * per-folder sorts; omit it and every group falls back to manual sortOrder.
 */
export function groupItemsByFolder(
  items: readonly Item[],
  folders: readonly Folder[] = [],
): Map<string, Item[]> {
  const sortByOf = new Map(folders.map((f) => [f.id, f.sortBy]));
  const byFolder = new Map<string, Item[]>();
  for (const item of items) {
    if (item.folderId == null || item.parentId != null) continue; // top-level only
    const group = byFolder.get(item.folderId);
    if (group) group.push(item);
    else byFolder.set(item.folderId, [item]);
  }
  for (const [fid, group] of byFolder)
    group.sort((a, b) => compareItemsBy(sortByOf.get(fid), a, b));
  return byFolder;
}

/**
 * Group nested children by their parent id, each group in sortOrder (matching
 * childrenOf). One O(items) pass, built once per snapshot at the view root and
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
 * Compute the four rollups. base = total − worn − consumable.
 * The math keys off effective classification, never folder names, so lists
 * stay comparable no matter how each person folders.
 */
export function computeTotals(list: ListData): Totals {
  let totalMg = 0;
  let wornMg = 0;
  let consumableMg = 0;
  let hasWeights = false;

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
    else if (cls === "consumable") consumableMg += line;
    else {
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
    itemCount: list.items.length,
    hasWeights,
  };
}

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
    const stepStr = step.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return withUnit ? `<${stepStr} ${unit}` : `<${stepStr}`;
  }
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
