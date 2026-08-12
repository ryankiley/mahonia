// The social-card image's CONTENT — which strings appear on the card a pasted
// list link unfurls into. Pure data in, data out: the server template
// (server/utils/ogCard.ts) draws exactly this model, the read pages' meta
// derives the image's alt text from it, and the tests assert on it without
// rasterizing anything. What the card SAYS is decided once, here.

import { tidyText } from "./tidyText";
import type { ListData, ListSnapshot, Totals } from "./types";
import { autoUnit, computeTotals, formatWeight, formatWeightAuto, totalsChips, unitSystem } from "./weights";

// The canvas — og:image's canonical 1200×630. The meta tags (og:image:width/height)
// and the renderer read these same two numbers, so they can't disagree.
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export interface OgCardModel {
  title: string;
  /** The headline figure — number and unit apart, because the card renders the
   *  unit smaller beside the number, the same treatment TotalsBar gives it. For a
   *  list with no weights the pair is the item count ("14" + "items"): the list is
   *  the hero and weight is optional, so an unweighed list still gets a card that
   *  says something true instead of a zero. */
  big: { value: string; unit: string };
  /** The classification breakdown, small, under the big figure — same rows and
   *  same judgment calls as TotalsBar's chips (via totalsChips). */
  chips: { label: string; value: string }[];
}

// Everything the card can draw — Latin, Latin-1, Latin Extended-A, general
// punctuation, minus sign, euro — as inclusive codepoint ranges. This is the
// SINGLE SOURCE the title-strip regex below is built from, and
// tests/ogCard.test.ts reads the shipped fonts' cmap and asserts every
// codepoint here has a glyph in all four faces — so a font re-subset that
// narrows coverage (regen command: server/assets/fonts/README.md) fails a test
// instead of shipping titles with holes where glyphs should be.
//
// The gaps inside the blocks are where Inter itself has no glyph (measured off
// the shipped cmaps, which is why the test can demand full coverage): the
// format characters — soft hyphen, ZWJ/ZWNJ, bidi controls, line/paragraph
// separators, invisible operators — plus U+0149 (deprecated ʼn) and the
// four-dot punctuation cluster. Stripping the format characters is what you'd
// want even if they had glyphs: they're steering codes, not marks.
export const DRAWABLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0020, 0x007e],
  [0x00a0, 0x00ac],
  [0x00ae, 0x00ff],
  [0x0100, 0x0148],
  [0x014a, 0x017f],
  [0x2000, 0x200b],
  [0x2010, 0x2027],
  [0x202f, 0x2055],
  [0x2057, 0x2057],
  [0x205f, 0x205f],
  [0x2212, 0x2212],
  [0x20ac, 0x20ac],
];

const hex = (n: number) => `\\u${n.toString(16).padStart(4, "0")}`;
const DRAWABLE = new RegExp(
  `[${DRAWABLE_RANGES.map(([lo, hi]) => (lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`)).join("")}]`,
);

/** A title reduced to what the card can draw. A glyph outside the ranges
 *  (emoji, CJK) would render as nothing at all, so it's stripped up front —
 *  then tidied exactly like every stored title (tidyText collapses the gap a
 *  strip leaves behind). A title that was ALL such glyphs falls back to the
 *  plain noun rather than shipping a blank card. */
export function ogCardTitle(raw: string): string {
  const kept = [...raw].filter((ch) => DRAWABLE.test(ch)).join("");
  return tidyText(kept) || "A packing list";
}

/** What the card needs from a list: the name, the owner's unit, and (when the
 *  totals aren't already at hand) the items to roll up. Every ListSnapshot
 *  satisfies this. */
export type OgCardSource = Pick<ListSnapshot, "title" | "displayUnit"> & ListData;

export function ogCardModel(list: OgCardSource, totals: Totals = computeTotals(list)): OgCardModel {
  // The UNFURL reads in the owner's measurement system — the card and the
  // og:description beside it both, via this same rule — because a share is the
  // owner presenting their pack to their own audience ("18.6 lb", not a
  // conversion). The PAGE under the link deliberately differs: it starts in
  // grams so lists compare like-for-like, and the viewer retunes it — see
  // useReadonlyList, which owns that rule. The two disagree on purpose.
  const system = unitSystem(list.displayUnit);
  const unit = autoUnit(totals.totalMg, system);
  const big = totals.hasWeights
    ? { value: formatWeight(totals.totalMg, unit, { withUnit: false }), unit }
    : { value: String(totals.itemCount), unit: totals.itemCount === 1 ? "item" : "items" };
  return {
    title: ogCardTitle(list.title),
    big,
    chips: totalsChips(totals).map((c) => ({
      label: c.label,
      value: formatWeightAuto(c.mg, { system }),
    })),
  };
}

/** What the image shows, as a sentence — the og:image:alt beside the card. */
export function ogCardAlt(m: OgCardModel): string {
  const breakdown = m.chips.map((c) => `${c.label} ${c.value}`).join(" · ");
  return `${m.title} — ${m.big.value} ${m.big.unit}${breakdown ? `. ${breakdown}` : ""}. On Mahonia.`;
}
