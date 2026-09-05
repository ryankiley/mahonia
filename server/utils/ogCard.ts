// Draws the social-card image a pasted list link unfurls into: the list's name,
// the pack weight big, and the Base / Worn / Consumable breakdown small — a
// miniature of the read view itself, in the same order the page presents them
// (wordmark, name, the big figure, the chips).
//
// satori lays the card out and returns SVG with every glyph as a <path> (so the
// rasterizer needs no fonts of its own); resvg rasterizes that to PNG. Both are
// server-only — none of this can reach the client bundle. WHAT the card says is
// not decided here: that's shared/ogCard.ts's model, which the read pages' meta
// (alt text) and the tests read too. This file only decides how it looks.
//
// The look transcribes the app's own type system (foundations/typography.scss +
// TotalsBar): two weights (400/600), 700 for the page-title role, tight tracking
// on numbers and titles, the unit smaller and muted beside the big figure, labels
// sentence-case 600 in secondary ink. Colors are the light-theme tokens — the
// card is always light, paper being the brand's ground. Faces are Inter (the
// closest OFL stand-in for the site's system-ui stack — a lambda has no system
// fonts), with InterDisplay for the two display-size runs, subset into
// server/assets/fonts (coverage rule: shared/ogCard.ts's DRAWABLE_RANGES).

import satori, { type SatoriOptions } from "satori";
import { Resvg } from "@resvg/resvg-js";
import { sendRedirect, setHeader, type H3Event } from "h3";
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  ogCardModel,
  type OgCardModel,
  type OgCardSource,
} from "../../shared/ogCard";
import { setReadEdgeCache } from "./http";
import { ogFonts } from "./ogFonts";

// tokens.scss, light values: --paper / --ink / --ink-2
const PAPER = "#ffffff";
const INK = "#000000";
const INK_2 = "#595959";
const TRACK_TIGHT = "-0.02em"; // --track-tight

// The big figure's two sizes, named because the baseline correction below is a
// function of their difference.
const BIG_SIZE = 170;
const UNIT_SIZE = 54;

// Where the baseline sits inside a satori line box, as the fraction of fontSize
// between the BASELINE and the BOX BOTTOM at lineHeight 1 — derived from Inter's
// hhea metrics (ascender 1984, descender −494, unitsPerEm 2048; identical across
// all four subset faces, asserted by tests/ogCard.test.ts):
//   content = (asc + desc) / upm = 1.21 em; half-leading = (1 − 1.21) / 2
//   baseline from top = half-leading + asc / upm = 0.86377 → from bottom 0.13623
//
// Needed because satori's `alignItems: baseline` silently degrades to BOX-BOTTOM
// alignment when the flex items are element children (our wrapper divs) rather
// than bare text — measured: the unit's baseline landed 0.13623·(170−54) ≈ 16 px
// below the number's, uniformly across values, units and letter-spacings. So the
// row bottom-aligns on purpose and the unit is raised by exactly that amount.
const BASELINE_BOTTOM_SHARE = 0.13623;
const UNIT_BASELINE_LIFT = Math.round(BASELINE_BOTTOM_SHARE * (BIG_SIZE - UNIT_SIZE));

// public/icon.svg — the Mahonia M — with its <style> block (a dark-mode media
// query) flattened to a plain fill: the card is always the light theme, and
// resvg doesn't evaluate media queries anyway. Keep the path in sync with the
// favicon if the mark is ever redrawn.
const MARK_SVG = `<svg viewBox="0 0 367 367" xmlns="http://www.w3.org/2000/svg"><path fill="${INK}" transform="translate(26 0)" d="M215.25 367C231 304.086 225.75 209.714 199.5 209.714C183.75 209.714 178.5 246.414 194.25 288.357C173.25 272.629 141.75 272.629 120.75 288.357C136.5 246.414 131.25 209.714 115.5 209.714C89.25 209.714 84 304.086 99.75 367C78.75 346.029 26.25 346.029 5.25 367C21 330.3 47.25 288.357 0 241.171C63 193.986 26.25 89.1286 10.5 52.4286C52.5 52.4286 84 26.2143 99.75 0C110.25 83.8857 136.5 157.286 157.5 157.286C178.5 157.286 204.75 83.8857 215.25 0C231 26.2143 262.5 52.4286 304.5 52.4286C283.5 99.6143 267.75 141.557 315 188.743C262.5 235.929 288.75 309.329 309.75 367C288.75 346.029 236.25 346.029 215.25 367Z"/></svg>`;
const MARK_SRC = `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`;
const MARK_SIZE = 64;

// satori's vnode shape, sans JSX — the element-object form its ReactNode input
// type expects (`key: null` included, which is what makes it a ReactElement to
// TS; satori itself has no reconciler and never reads it). Everything is a flex
// <div>; leaves hold text.
type Vnode = {
  type: string;
  props: Record<string, unknown>;
  key: null;
};
const el = (style: Record<string, unknown>, children?: unknown): Vnode => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children },
  key: null,
});

// The breakdown row's metrics, named so the fit calculation below and the markup can
// never disagree: the design size, the space between chips and between a chip's label
// and its value, the drawing width between the card's 72px paddings, and Inter's
// average advance as a fraction of the em (measured across the label/figure mix this
// row holds — digits and spaces run narrower than 0.5em, capitals wider).
const CHIP_SIZE = 40;
const CHIP_GAP = 48;
const CHIP_PAIR_GAP = 14;
const CARD_INNER_W = 1200 - 72 * 2;
// Inter's average advance across this row's label/figure mix, measured off the raster
// (tests/ogCard.test.ts renders a tonne-scale breakdown and checks the ink stops inside
// the padding). Erring high is the safe direction: it shrinks a shade early rather than
// letting a heavy list run off the card.
const CHIP_ADVANCE_EM = 0.56;

function cardVnode(m: OgCardModel): Vnode {
  return el(
    {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      padding: "64px 72px",
      backgroundColor: PAPER,
      color: INK,
      fontFamily: "Inter",
    },
    [
      // The top strip: the LIST'S NAME where a wordmark would sit, and the
      // favicon's M holding the opposite corner — the mark alone carries the
      // brand here (the unfurl's site_name/domain line already says Mahonia,
      // and the site card spells it out). One fixed size now that the name is
      // a label rather than the hero: at 40px the line fits ~45 characters,
      // and satori's block + lineClamp wraps then ellipsizes past two lines.
      // flex-start so both hang from the top edge.
      el({ flexDirection: "row", alignItems: "flex-start" }, [
        el(
          {
            display: "block",
            lineClamp: 2,
            flexGrow: 1,
            marginRight: 48,
            fontFamily: "InterDisplay",
            fontWeight: 700,
            fontSize: 40,
            lineHeight: 1.15,
            letterSpacing: TRACK_TIGHT,
            wordBreak: "break-word",
          },
          m.title,
        ),
        { type: "img", props: { src: MARK_SRC, width: MARK_SIZE, height: MARK_SIZE }, key: null },
      ]),
      el({ flexGrow: 1 }),
      // the big figure — number dominant, unit smaller and muted ON ITS BASELINE,
      // exactly TotalsBar's totals__big + totals__unit pairing. Bottom-aligned
      // with the unit lifted by the computed correction — see UNIT_BASELINE_LIFT
      // for why `baseline` itself can't be trusted here.
      el({ flexDirection: "row", alignItems: "flex-end" }, [
        el(
          {
            fontFamily: "InterDisplay",
            fontSize: BIG_SIZE,
            lineHeight: 1,
            letterSpacing: TRACK_TIGHT,
          },
          m.big.value,
        ),
        el(
          {
            marginLeft: 18,
            marginBottom: UNIT_BASELINE_LIFT,
            fontSize: UNIT_SIZE,
            lineHeight: 1,
            color: INK_2,
            letterSpacing: "-0.01em",
          },
          m.big.unit,
        ),
      ]),
      // the breakdown, small — the ask behind this card: pack weight up top,
      // Base / Worn / Consumable in smaller text beneath it
      m.chips.length
        ? (() => {
            // One line, always inside the card. At the design size the row ran off the
            // right edge on a heavy list — "Consumable 150.03" was cut mid-number with
            // its unit gone — because nothing here shrinks and satori does not scroll.
            // Rather than wrap (a second line would collide with the card's bottom
            // edge), step the whole row down when the text it holds is too long for
            // the 1056px between the paddings. `min` so an ordinary breakdown, which
            // is the overwhelming majority, renders at exactly the size it always did.
            // no separator characters: every gap in this row is a margin, and `gaps`
            // below already subtracts each one. A space here would charge the budget
            // for it twice and shrink the row earlier than it needs to.
            const text = m.chips.map((c) => `${c.label}${c.value}`).join("");
            // The gaps SCALE with the row, so they can't be subtracted at full size and
            // then shrunk — that budgets for margins wider than the ones drawn and
            // lands the row outside the card anyway. Solve for the size at which the
            // whole row (text + margins, both scaled) is exactly CARD_INNER_W wide:
            //   size × (ADVANCE × chars) + CHIP_GAPS × (size / CHIP_SIZE) = CARD_INNER_W
            const gaps = (m.chips.length - 1) * CHIP_GAP + m.chips.length * CHIP_PAIR_GAP;
            const perPx = CHIP_ADVANCE_EM * text.length + gaps / CHIP_SIZE;
            const size = Math.min(CHIP_SIZE, Math.floor((CARD_INNER_W / perPx) * 10) / 10);
            const scale = size / CHIP_SIZE;
            return el(
              { flexDirection: "row", marginTop: 32 },
              m.chips.map((c, i) =>
                el({ marginLeft: i ? Math.round(CHIP_GAP * scale) : 0, fontSize: size }, [
                  el({ fontWeight: 600, color: INK_2 }, c.label),
                  el({ marginLeft: Math.round(CHIP_PAIR_GAP * scale) }, c.value),
                ]),
              ),
            );
          })()
        : null,
    ],
  );
}

// The SITE's own card — what unfurls when there is no list to draw: bare /e, the
// legal pages, a dead link, and sendOgCard's failure fallback. The M mark large
// and centered, the wordmark and the one-liner under it. NOT rendered at request
// time: scripts/render-og-site.ts rasterizes this once into public/og.png (a
// static file can't fail, which is what a failure fallback must be), and a test
// re-renders it against the committed bytes so the template and the file can't
// drift. The one-liner mirrors editorSeo's GENERIC_TITLE, which app code owns.
const SITE_MARK_SIZE = 264;
function siteCardVnode(): Vnode {
  return el(
    {
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      width: "100%",
      height: "100%",
      backgroundColor: PAPER,
      color: INK,
      fontFamily: "Inter",
    },
    [
      { type: "img", props: { src: MARK_SRC, width: SITE_MARK_SIZE, height: SITE_MARK_SIZE }, key: null },
      el({ marginTop: 48, fontWeight: 600, fontSize: 50 }, "Mahonia"),
      el({ marginTop: 14, fontSize: 40, color: INK_2 }, "Pack lists, weighed."),
    ],
  );
}

/** A card as SVG — the testable middle step (deterministic string out).
 *  `fonts` stays a parameter as the test seam: the routes load them from Nitro
 *  server assets (ogFonts), the tests from the filesystem. */
function svgOf(vnode: Vnode, fonts: SatoriOptions["fonts"]): Promise<string> {
  return satori(vnode, { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, fonts });
}

/** A card as PNG bytes. Skip resvg's default system-font scan: satori has
 *  already turned every glyph into a <path>, so there is no text left to shape
 *  and the scan would walk the platform's font directories per render for
 *  nothing. */
async function pngOf(vnode: Vnode, fonts: SatoriOptions["fonts"]): Promise<Buffer> {
  return new Resvg(await svgOf(vnode, fonts), { font: { loadSystemFonts: false } })
    .render()
    .asPng();
}

export const renderOgSiteCard = (fonts: SatoriOptions["fonts"]) => pngOf(siteCardVnode(), fonts);
export const ogCardSvg = (m: OgCardModel, fonts: SatoriOptions["fonts"]) => svgOf(cardVnode(m), fonts);
export const renderOgCard = (m: OgCardModel, fonts: SatoriOptions["fonts"]) => pngOf(cardVnode(m), fonts);

/**
 * The whole response tail the two og routes share: model → fonts → render →
 * headers, and the one fallback policy. What stays IN the routes is exactly
 * what differs between them — which repo resolves the list, and whether the
 * surface is indexable (setNoIndex) — the same division of labor as
 * setNoIndex/notFound themselves. (This is not the rate-limit-and-headers
 * wrapper server/utils/http.ts warns against: rateLimit and its ordering stay
 * at the call sites.)
 */
export async function sendOgCard(event: H3Event, list: OgCardSource): Promise<Buffer | void> {
  try {
    const png = await renderOgCard(ogCardModel(list), await ogFonts());
    setHeader(event, "Content-Type", "image/png");
    // same edge window as the page — the pair a crawler fetches goes stale together
    setReadEdgeCache(event);
    return png;
  } catch (e) {
    // The card is best-effort chrome — a render failure falls back to the
    // static site card (public/og.png, prerendered by scripts/render-og-site.ts:
    // a committed file, so THIS path cannot fail the same way) rather than a
    // broken unfurl. Logged, because this otherwise fails silent-and-forever
    // (e.g. a deploy missing the font assets would 302 every card with zero
    // signal). no-store: never cache the outage.
    console.error("og card render failed, serving static fallback:", e);
    setHeader(event, "Cache-Control", "no-store");
    return sendRedirect(event, "/og.png", 302);
  }
}
