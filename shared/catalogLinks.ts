// What a stored catalog link means once the catalog has moved on.
//
// A list row and a My Gear row both remember the product they came from twice: as a
// catalog id, and as the brand, name and variant the product carried the day it was
// picked. The catalog then changes under them. A variant is tidied ("M" to "Medium",
// "size 3, M" to "JP 3"), two rows that distinguished nothing fold into one ("single
// bar" and "per bar" into the bar). Until 2026-10-31 the seed DELETED any row it could
// not rename one-for-one, so a link could outlive its row, and the remembered text then
// disagreed with everything that came after it. My Gear keys gear on that text, so each
// disagreement minted a second row for one thing.
//
// The seed no longer deletes. A row the research stops naming is retired with a pointer
// to the row that replaced it, and readers follow the pointer. These are the rules the
// seed uses to find that row. They are pure, so a test can pin them, and strict in one
// direction: an orphan that could mean two live rows points at neither. A wrong pointer
// would rename someone's gear on every read, which is worse than an old name standing.

import { sizeLettersToWords } from "./catalogQuality";
import { foldForSearch } from "./searchText";
import { itemDisplayName } from "./weights";

/** The text side of a link: what a row remembers about the product it came from. */
export interface LinkText {
  brand?: string | null;
  name: string;
  variant?: string | null;
}

/** A live catalog row, as far as matching needs it. */
export interface LinkCandidate extends LinkText {
  id: number;
  weightMg: number;
}

/** Words that never tell two products apart: "Size L" and "L" are one size, "US 11"
 *  and "size 11" one shoe, and a lone "s" is what a possessive leaves after the fold. */
const FILLER = new Set(["size", "us", "the", "s"]);

/** Within half a gram: the same figure recorded at two precisions (411.068 and 411.1). */
const SAME_WEIGHT_MG = 500;

/**
 * The set of words a piece of product text comes to once spelling stops mattering.
 * Every step is symmetric, so it can only ever make two spellings of one thing agree:
 *  - inch and foot marks read as words, so 20" and 20in agree;
 *  - "one size" says nothing, so a pillow in "One size" is the pillow;
 *  - size letters read as words, the catalog's own rule, so M and Medium agree;
 *  - "+" survives as a word, so "Lone Peak 9+" never meets "Lone Peak 9";
 *  - digits part from letters, so 140cm and 140 cm, 0.15oz and 0.15 oz agree;
 *  - a plural is its singular, so Tubes and Tube agree.
 * A SET, not a sequence: "Medium, JP 3" and "JP 3, Medium" are one variant, and a model
 * number repeated in a name ("Power Bank (P50) P50-E1") is still that one model.
 */
export function spellingWords(text: string): Set<string> {
  const spaced = sizeLettersToWords(
    text
      .replace(/(\d)\s*(?:"|″|”)/g, "$1 in ")
      .replace(/(\d)\s*(?:'|′|’)(?!s\b)/g, "$1 ft ")
      .replace(/\bone[\s-]*size\b/gi, " ")
      .replace(/\+/g, " plus "),
  );
  const folded = foldForSearch(spaced)
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2");
  const words = new Set<string>();
  for (const raw of folded.split(" ")) {
    if (!raw || FILLER.has(raw)) continue;
    words.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return words;
}

const sameWords = (a: Set<string>, b: Set<string>): boolean =>
  a.size > 0 && a.size === b.size && [...a].every((w) => b.has(w));

const productWords = (t: LinkText) => spellingWords(itemDisplayName(t.brand, t.name));
const variantWords = (t: LinkText) => spellingWords(t.variant ?? "");
/** Product and variant read apart, then pooled. Apart because the size rule won't
 *  touch a letter that follows a number ("Distance 22 M" could be metres), and a
 *  variant read on its own starts fresh; pooled because a name sometimes carries what
 *  the catalog later moved into the variant ("Kakwa 55 UltraGrid / M"). */
const fullWords = (t: LinkText) => new Set([...productWords(t), ...variantWords(t)]);

/** Are these two the same product AND the same variant, spelled two ways? The test for
 *  "this text is a catalog row's text, from before a tidy", which is the one case where
 *  replacing it with the catalog's current text loses nothing anyone wrote. */
export function sameSpelling(a: LinkText, b: LinkText): boolean {
  return sameWords(fullWords(a), fullWords(b));
}

/** The same product, whatever the variant: brand and name agree after the fold. */
export function sameProduct(a: LinkText, b: LinkText): boolean {
  return sameWords(productWords(a), productWords(b));
}

/**
 * How a successor was recognised, for the seed's log and the tests.
 *  - "spelling": the old row's text, spelled before a tidy.
 *  - "variantless": the product's one live row, and one side has no variant, so the
 *    two can't disagree about one ("single bar" folded into the bar).
 *  - "weight": the product's one live row at the same weight, under a variant that
 *    reads differently ("size 3, M" and "JP 3", both 420 g).
 * All three are applied to CATALOG rows, whose text nobody typed. Applied to a person's
 * own row, "weight" would be too weak: a Medium picked, retyped "L" and left at the
 * Medium's weight reads exactly the same way.
 */
export type SuccessorBasis = "spelling" | "variantless" | "weight";

export interface Successor<C extends LinkCandidate> {
  row: C;
  by: SuccessorBasis;
}

/**
 * The live row an old link now means, or null when that isn't certain.
 *
 * 1. One live row spells the same thing: that row. Two: neither.
 * 2. Otherwise the product's live rows (brand and name agree). If there is exactly one,
 *    it is the answer when the variants can't disagree (one side has none) or the
 *    weights match. A different size at a different weight is a size the catalog
 *    dropped, and is left alone. With several live rows, the weight must pick out one.
 *
 * `weightMg` is the weight the link was made at, when the caller knows it: a list row's
 * catalogWeightMgAtLink, a My Gear row's own weight.
 */
export function matchSuccessor<C extends LinkCandidate>(
  ref: LinkText & { weightMg?: number | null },
  candidates: readonly C[],
): Successor<C> | null {
  const spelled = candidates.filter((c) => sameSpelling(ref, c));
  if (spelled.length) return spelled.length === 1 ? { row: spelled[0]!, by: "spelling" } : null;

  const product = productWords(ref);
  const family = candidates.filter((c) => sameWords(productWords(c), product));
  const weight = typeof ref.weightMg === "number" && ref.weightMg > 0 ? ref.weightMg : null;
  const weighsTheSame = (c: C) => weight != null && Math.abs(c.weightMg - weight) <= SAME_WEIGHT_MG;

  if (family.length === 1) {
    const only = family[0]!;
    if (variantWords(ref).size === 0 || variantWords(only).size === 0) return { row: only, by: "variantless" };
    return weighsTheSame(only) ? { row: only, by: "weight" } : null;
  }
  const byWeight = family.filter(weighsTheSame);
  return byWeight.length === 1 ? { row: byWeight[0]!, by: "weight" } : null;
}
