// A linked row's other sizes: what changing the size of a catalog pick writes.
//
// A row picked from the catalog is linked to ONE size of its product, and carries that
// size's cited weight. Its Size field used to change only the text, so "Long" could sit
// on a row still linked to the Regular and weighing what the Regular weighs. These are
// the two ways the size changes now, as patches, so the row and the tests share them:
//   · picking another size relinks the row to it and takes its weight, as a pick does;
//   · typing a size relinks when the product is sold in it, and otherwise unlinks: the
//     size is the person's own, the weight is theirs to correct, and the row is typed
//     gear again, which the candidates pipeline stages for the catalog like any other.
import { foldForSearch } from "./searchText";
import type { ItemPatch } from "./ops";
import type { Item } from "./types";

/** One size of a product, as /api/catalog/sizes returns it. */
export interface CatalogSize {
  id: number;
  variant: string | null;
  weightMg: number;
  kcal: number | null;
}

/** The sizes in the order a person reads them: "5F" before "10F", "Short" beside "Long". */
export function sortSizes<T extends { variant: string | null; id: number }>(sizes: readonly T[]): T[] {
  return [...sizes].sort(
    (a, b) => (a.variant ?? "").localeCompare(b.variant ?? "", "en", { numeric: true }) || a.id - b.id,
  );
}

/** Relink to another size of the same product: its id, its words, its cited weight. The
 *  brand, name and gear type stay, because the product hasn't changed. */
export function sizePickPatch(size: CatalogSize): ItemPatch {
  const patch: ItemPatch = {
    catalogItemId: size.id,
    variant: size.variant ?? "",
    unitWeightMg: size.weightMg,
    catalogWeightMgAtLink: size.weightMg,
    weightOverridden: false,
    nameOverridden: false,
  };
  if (size.kcal != null) patch.kcal = size.kcal;
  return patch;
}

const sameSize = (a: string | null | undefined, b: string | null | undefined) =>
  foldForSearch(a ?? "") === foldForSearch(b ?? "");

/** Whether typedSizePatch has a question only the product's sizes answer: a linked row
 *  now saying some other size. Anything else is decided without them, so the field
 *  doesn't wait on the network to clear a size or to change an unlinked row's. */
export function typedSizeNeedsSizes(item: Item, typed: string): boolean {
  const text = typed.trim();
  return item.catalogItemId != null && !!text && !sameSize(text, item.variant);
}

/**
 * What typing `typed` into a row's Size field writes. Null when nothing changes.
 *
 * `sizes` is the linked product's sizes, or null when they couldn't be had (offline):
 * then a size other than the linked one can only unlink, which is still true, since the
 * link's weight is for the size the row no longer says.
 *
 * Clearing the field keeps the link: a blank size isn't a claim to be some other size,
 * only a row that doesn't say which.
 */
export function typedSizePatch(item: Item, typed: string, sizes: readonly CatalogSize[] | null): ItemPatch | null {
  const text = typed.trim();
  if (item.catalogItemId == null || !text) {
    if (text === (item.variant ?? "")) return null;
    return { variant: text, nameOverridden: true };
  }
  if (sameSize(text, item.variant)) return null;
  // the linked size itself counts: a row whose text had drifted from its link (the old
  // field wrote text only) is put right by typing the size it is linked to
  const match = sizes?.find((s) => sameSize(s.variant, text));
  if (match) return sizePickPatch(match);
  return { variant: text, catalogItemId: null, nameOverridden: true, weightOverridden: true };
}
