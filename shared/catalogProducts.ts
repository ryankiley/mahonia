// A catalog PRODUCT: the rows that share a brand and a model and differ only in the size
// or version. The catalog stores a row per version (that is what a list links to and a
// weight is cited for), and the menu asks for a product first and its version second, so
// "same product" is asked in three places: the ranker groups by it (shared/catalogSearch),
// the menu draws one row per product, and the version step lists and narrows its rows.
//
// Its own module, importing only the text folds: the menu runs this on the editor's first
// load, and the ranker it would otherwise sit beside is behind a dynamic import (see the
// header of shared/searchText.ts for what one static import of that file once cost).

import type { CatalogSearchResult } from "./catalogSearch";
import { foldForSearch, foldKeepingPlus } from "./searchText";

/** One fold for "the same product", exact matching's (foldKeepingPlus): "Lone Peak 9"
 *  and "Lone Peak 9+" are two products, and so are a -15F bag and a 15F one. */
export function productKey(brand: string | null | undefined, name: string): string {
  return `${foldKeepingPlus(brand ?? "")}|${foldKeepingPlus(name)}`;
}

// "en", not the runtime's locale: the server and the device must put a product's
// versions in the same order, and a list sorted by the visitor's locale would not.
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** A product's versions in reading order: numbers by value ("10F" before "20F", "2P"
 *  before "10P"), so a quilt's ratings and lengths fall into a table, and the row with
 *  no version at all (the plain model beside its "Active Noise Cancellation") first. */
export function compareVersions(
  a: { id: number; variant: string | null },
  b: { id: number; variant: string | null },
): number {
  return natural.compare(a.variant ?? "", b.variant ?? "") || a.id - b.id;
}

export interface CatalogProduct<T extends CatalogSearchResult = CatalogSearchResult> {
  key: string;
  /** Every version in hand, in the order they arrived. */
  rows: T[];
}

/** Rows gathered into products, each product where its first row stood. The search
 *  answers with a product's rows together, so this is a walk; rows that arrive apart
 *  (an older response, the two halves of a merge) still land in one product. */
export function groupProducts<T extends CatalogSearchResult>(rows: readonly T[]): CatalogProduct<T>[] {
  const byKey = new Map<string, CatalogProduct<T>>();
  for (const row of rows) {
    const key = productKey(row.brand, row.name);
    const product = byKey.get(key);
    if (product) product.rows.push(row);
    else byKey.set(key, { key, rows: [row] });
  }
  return [...byKey.values()];
}

/**
 * The versions the typed words still fit: every word must begin a word of the version
 * ("20 reg w" fits "20F, Regular Wide" and not "20F, Regular"). The order given is kept,
 * so the list holds still while it shortens. No words is every version; words that fit
 * nothing is none, which is the menu's cue to offer the typed text as a size of its own.
 */
export function narrowVersions<T extends { variant: string | null }>(rows: readonly T[], text: string): T[] {
  const typed = versionFold(text);
  if (!typed) return [...rows];
  const words = typed.split(" ");
  return rows.filter((r) => {
    const have = versionWords(r.variant);
    return words.every((w) => have.some((h) => h.startsWith(w)));
  });
}
const versionWords = (variant: string | null) => versionFold(variant ?? "").split(" ");

/** The fold a version's text is compared in: the search fold, with apostrophes closed up
 *  first. The search fold turns one into a space, which makes "Women's" the two words
 *  "women s", and then "womens", the way it is typed as often as not, begins neither. */
export function versionFold(text: string): string {
  return foldForSearch(text.replace(/['’ʼ]/g, ""));
}

/**
 * Of the versions words have narrowed to, the one they most nearly say: the version
 * with the fewest words of its own, the first of them in the order given. "6ft wide"
 * fits "6ft 6in Wide" too, which reads first; "solar" fits "Sapphire Solar"; "regular"
 * fits "Regular Wide". In each the shorter one is what was typed, and it is the row the
 * menu lights. -1 for no rows.
 */
export function nearestVersion(rows: readonly { variant: string | null }[]): number {
  let at = -1;
  let fewest = Infinity;
  rows.forEach((r, i) => {
    const n = versionWords(r.variant).length;
    if (n < fewest) [at, fewest] = [i, n];
  });
  return at;
}

/**
 * Is the typed text the START of this version, word for word ("wom" of "Women's", "20
 * reg" of "20F, Regular Wide")? Then it is that version being typed, not a size of the
 * person's own, and the menu doesn't offer it as one. "large" fits "X-Large" without
 * beginning it, and is offered: it is as likely the Large the catalog lacks.
 */
export function beginsVersion(text: string, variant: string | null): boolean {
  const typed = versionFold(text);
  if (!typed) return false;
  const have = versionWords(variant);
  return typed.split(" ").every((w, i) => have[i]?.startsWith(w));
}

/**
 * The words of a search that name no part of the product: what "ghost whisperer hoody
 * women" or "alphalite 20 reg" says beyond the product it found. They are the start of
 * the version step's narrowing, so a size typed with the name isn't typed again. A word
 * that begins a word of the brand or model is the name's ("900" in "AlphaLite 900
 * Quilt"); the rest come back in the order typed, folded.
 */
export function leftoverWords(typed: string, product: { brand: string | null; name: string }): string {
  const name = versionFold(`${product.brand ?? ""} ${product.name}`).split(" ");
  return versionFold(typed)
    .split(" ")
    .filter((w) => w && !name.some((n) => n.startsWith(w)))
    .join(" ");
}
