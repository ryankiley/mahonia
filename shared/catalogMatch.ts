// Recognising a catalog product from an imported row's name — the exact-match half of
// what the autocomplete does when you pick one. An import (LighterPack, a CSV, a backup
// from before links) arrives as free text; where that text IS a catalog product word
// for word, the row can behave as if it had been picked: linked, so the catalog's
// weight check and My Gear know it. Exact only. A near miss stays the custom row it is,
// because linking the wrong product silently would be worse than linking nothing.
// Pure + shared: the server builds the index over the live catalog, and both sides fold
// names through the one search fold, so they can't disagree about what "the same" is.
// Here too is what a row takes from a product once linked (pickFromCatalog), the one
// rule the editor's pick, a paste, an import and the connector all apply.

import type { CatalogSearchResult } from "./catalogSearch";
import type { ItemPatch } from "./ops";
import { foldKeepingPlus } from "./searchText";
import { sameText } from "./tidyText";
import type { Classification, Folder, Item } from "./types";
import { itemDisplayName, storedClassification } from "./weights";

/** The folded names a catalog row answers to: brand + model, and the same with its
 *  variant on the end ("Nemo Tensor All-Season Insulated Sleeping Pad Regular"). An
 *  unbranded row answers to its bare model. */
export function catalogNameKeys(row: Pick<CatalogSearchResult, "brand" | "name" | "variant">): string[] {
  const shown = foldKeepingPlus(itemDisplayName(row.brand, row.name));
  if (!shown) return [];
  const keys = [shown];
  if (row.variant) {
    const withVariant = foldKeepingPlus(itemDisplayName(row.brand, row.name, row.variant));
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
  return foldKeepingPlus(itemDisplayName(row.brand ?? null, row.name, row.variant ?? null));
}

export function lookupImported(index: CatalogNameIndex, row: ImportedName): CatalogSearchResult | null {
  const key = importedNameKey(row);
  return key ? (index.get(key) ?? null) : null;
}

/** What a row takes from a catalog product it is linked to. */
export type CatalogPickRow = Pick<CatalogSearchResult, "id" | "name" | "brand" | "variant" | "weightMg" | "commonName" | "categoryHint" | "kcal">;

/** The values a caller keeps over the product's; each left undefined takes the product's.
 *  WHOSE value wins differs by context (the editor's pick takes every catalog value, an
 *  import keeps the file's weight, the connector keeps what the call sent), so the caller
 *  decides and the rule only applies it. */
export interface CatalogPickOwn {
  weightMg?: number;
  /** stored as given, and marked overridden only where it differs from the product's */
  name?: string;
  brand?: string;
  variant?: string;
  /** a gear type kept as the row's; the product's, when taken, is marked not overridden */
  commonName?: string;
  /** null keeps "none" over the product's figure */
  kcal?: number | null;
  /** a class the caller set; null is an explicit "follow the folder" */
  classification?: Classification | null;
}

/** Where the row sits, which the classification rule reads. */
export interface CatalogPickPlace {
  folderId: string | null;
  folders: Folder[];
}

/**
 * What a list row takes from the catalog product it is linked to — the one rule the
 * editor's pick (ItemRow.onNameCommit), a paste, an import and the connector share: the
 * link and the product's weight at link time always, and its name, brand, variant, gear
 * type, weight and calories where the caller keeps no value of its own. A kept weight is
 * overridden only when it differs, so one equal to the product's keeps following catalog
 * corrections. A product without a calorie figure leaves the row's alone. A consumable
 * product is stored through storedClassification: null in a folder that already defaults
 * to consumable, so the row follows its folder.
 */
export function pickFromCatalog(catalog: CatalogPickRow, own: CatalogPickOwn, place: CatalogPickPlace): ItemPatch {
  const patch: ItemPatch = {
    catalogItemId: catalog.id,
    catalogWeightMgAtLink: catalog.weightMg,
    unitWeightMg: own.weightMg ?? catalog.weightMg,
    weightOverridden: own.weightMg !== undefined && own.weightMg !== catalog.weightMg,
    name: own.name ?? catalog.name,
    nameOverridden: own.name !== undefined && !sameText(own.name, catalog.name),
    brand: own.brand ?? catalog.brand ?? "",
    variant: own.variant ?? catalog.variant ?? "",
  };
  if (own.commonName !== undefined) patch.commonName = own.commonName;
  else {
    patch.commonName = catalog.commonName ?? "";
    patch.commonNameOverridden = false;
  }
  if (own.kcal !== undefined) patch.kcal = own.kcal;
  else if (catalog.kcal != null) patch.kcal = catalog.kcal;
  if (own.classification !== undefined) patch.classification = own.classification;
  else if (catalog.categoryHint === "consumable") patch.classification = storedClassification("consumable", place.folderId, place.folders);
  return patch;
}

/** A pick laid onto a whole row rather than sent as a patch: a cleared field is absent,
 *  as the reducer stores it. */
export function withCatalogPick(item: Item, patch: ItemPatch): Item {
  const out: Record<string, unknown> = { ...item };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "classification") out.classification = value ?? null;
    else if (value === "" || value === null) delete out[key];
    else out[key] = value;
  }
  return out as unknown as Item;
}

/** The row, linked: the pick, with the import's own truth kept where it has one. Its
 *  weight stands (a weightless row takes the cited one), and an explicit gear type or
 *  calorie figure stays. */
export function applyCatalogMatch(item: Item, row: CatalogSearchResult, folders: Folder[]): Item {
  const own: CatalogPickOwn = {
    weightMg: item.unitWeightMg > 0 ? item.unitWeightMg : undefined,
    commonName: item.commonName ?? undefined,
    kcal: item.kcal ?? undefined,
  };
  return withCatalogPick(item, pickFromCatalog(row, own, { folderId: item.folderId, folders }));
}

/** Link every unlinked row the answer recognises. `matches` is positional over `items`
 *  (the server answers in order); a row already linked (a JSON backup) or without a
 *  name is left as it is. `folders` are the list's, which a food row's class reads. */
export function linkImportedItems(
  items: Item[],
  matches: (CatalogSearchResult | null)[],
  folders: Folder[],
): { items: Item[]; matched: number } {
  let matched = 0;
  const out = items.map((item, i) => {
    const row = matches[i];
    if (!row || item.catalogItemId != null || !item.name.trim()) return item;
    matched++;
    return applyCatalogMatch(item, row, folders);
  });
  return { items: out, matched };
}
