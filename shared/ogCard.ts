// The social-card image's CONTENT — which strings appear on the card a pasted
// list link unfurls into. Pure data in, data out: the server template
// (server/utils/ogCard.ts) draws exactly this model, the read pages' meta
// derives the image's alt text from it, and the tests assert on it without
// rasterizing anything. What the card SAYS is decided once, here.

import type { Totals, Unit } from "./types";
import { autoUnit, formatWeight, formatWeightAuto, totalsChips, unitSystem } from "./weights";

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

// Everything the card can draw — the ranges the subset fonts in
// server/assets/fonts cover (Latin, Latin-1, Latin Extended-A, general
// punctuation). A glyph outside them (emoji, CJK) would render as nothing at
// all, so it's stripped up front; a title that was ALL such glyphs falls back
// to the plain noun rather than shipping a blank card. Resubset the fonts
// (server/assets/fonts/README.md) and this must change with them.
const DRAWABLE = /[\u0020-\u007E\u00A0-\u00FF\u0100-\u017F\u2000-\u206F\u2212\u20AC]/;

export function ogCardTitle(raw: string): string {
  const kept = [...raw].filter((ch) => DRAWABLE.test(ch)).join("");
  return kept.replace(/\s+/g, " ").trim() || "A packing list";
}

export function ogCardModel(title: string, totals: Totals, displayUnit: Unit): OgCardModel {
  // the card reads in the same measurement system the owner edits in — an
  // oz/lb list unfurls in pounds, not in the metric default
  const system = unitSystem(displayUnit);
  const unit = autoUnit(totals.totalMg, system);
  const big = totals.hasWeights
    ? { value: formatWeight(totals.totalMg, unit, { withUnit: false }), unit }
    : { value: String(totals.itemCount), unit: totals.itemCount === 1 ? "item" : "items" };
  return {
    title: ogCardTitle(title),
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
