// Recognising a catalog product from an imported row's name — the exact-match half of
// what the autocomplete does when you pick one. An import (LighterPack, a CSV, a backup
// from before links) arrives as free text; where that text IS a catalog product word
// for word, the row can behave as if it had been picked: linked, so the catalog's
// weight check and My Gear know it. Exact only. A near miss stays the custom row it is,
// because linking the wrong product silently would be worse than linking nothing.
// Pure + shared: the server builds the index over the live catalog, and both sides fold
// names through the one search fold, so they can't disagree about what "the same" is.

import type { CatalogSearchResult } from "./catalogSearch";
import type { Item } from "./types";
import { itemDisplayName } from "./weights";

/** The fold exact matching uses: the search fold (diacritics off, lowercase,
 *  punctuation to spaces) except that "+" survives — the one mark the catalog relies
 *  on to tell products apart ("X-Mid Pro 2" and "X-Mid Pro 2+", "Lone Peak 9" and
 *  "9+"). The search fold drops it, which is right for recall and wrong here: it made
 *  those pairs one ambiguous key, and an import naming either linked to neither. */
export function foldName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

/** The folded names a catalog row answers to: brand + model, and the same with its
 *  variant on the end ("Nemo Tensor All-Season Insulated Sleeping Pad Regular"). An
 *  unbranded row answers to its bare model. */
export function catalogNameKeys(row: Pick<CatalogSearchResult, "brand" | "name" | "variant">): string[] {
  const shown = foldName(itemDisplayName(row.brand, row.name));
  if (!shown) return [];
  const keys = [shown];
  if (row.variant) {
    const withVariant = foldName(itemDisplayName(row.brand, row.name, row.variant));
    if (withVariant !== shown) keys.push(withVariant);
  }
  return keys;
}

/** null marks a key two rows claim — an ambiguity, and an ambiguity is never a guess. */
export type CatalogNameIndex = Map<string, CatalogSearchResult | null>;

export function buildCatalogNameIndex(rows: CatalogSearchResult[]): CatalogNameIndex {
  const index: CatalogNameIndex = new Map();
  for (const row of rows) {
    for (const key of catalogNameKeys(row)) index.set(key, index.has(key) ? null : row);
  }
  return index;
}

/** What an imported row is looked up by: its own brand + name (+ variant) through the
 *  same fold. A LighterPack row carries the whole thing in `name`; Mahonia's own CSV
 *  keeps brand in its column, and the two compose to the same key. */
export type ImportedName = Pick<Item, "name" | "brand" | "variant">;

export function importedNameKey(row: ImportedName): string {
  return foldName(itemDisplayName(row.brand ?? null, row.name, row.variant ?? null));
}

export function lookupImported(index: CatalogNameIndex, row: ImportedName): CatalogSearchResult | null {
  const key = importedNameKey(row);
  return key ? (index.get(key) ?? null) : null;
}

/** The row, linked — the fields a pick sets (ItemInput.selectResult), with the import's
 *  own truth kept where it has one: its weight stands (marked overridden when it
 *  disagrees with the catalog, so nothing overwrites it and the "suggest a fix" line can
 *  appear), a weightless row takes the cited weight, an explicit gear type or calorie
 *  figure stays. Consumable arrives pre-classified, as it does from a pick. */
export function applyCatalogMatch(item: Item, row: CatalogSearchResult): Item {
  const keepsWeight = item.unitWeightMg > 0;
  return {
    ...item,
    name: row.name,
    brand: row.brand ?? undefined,
    variant: row.variant ?? undefined,
    commonName: item.commonName ?? row.commonName ?? undefined,
    nameOverridden: false,
    unitWeightMg: keepsWeight ? item.unitWeightMg : row.weightMg,
    weightOverridden: keepsWeight && item.unitWeightMg !== row.weightMg,
    catalogItemId: row.id,
    catalogWeightMgAtLink: row.weightMg,
    classification: row.categoryHint === "consumable" ? "consumable" : item.classification,
    kcal: item.kcal ?? row.kcal ?? undefined,
  };
}

/** Link every unlinked row the answer recognises. `matches` is positional over `items`
 *  (the server answers in order); a row already linked (a JSON backup) or without a
 *  name is left as it is. */
export function linkImportedItems(
  items: Item[],
  matches: (CatalogSearchResult | null)[],
): { items: Item[]; matched: number } {
  let matched = 0;
  const out = items.map((item, i) => {
    const row = matches[i];
    if (!row || item.catalogItemId != null || !item.name.trim()) return item;
    matched++;
    return applyCatalogMatch(item, row);
  });
  return { items: out, matched };
}
