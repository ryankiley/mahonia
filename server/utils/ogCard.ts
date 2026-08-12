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
// server/assets/fonts (see shared/ogCard.ts's DRAWABLE for the coverage rule).

import satori, { type SatoriOptions } from "satori";
import { Resvg } from "@resvg/resvg-js";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, type OgCardModel } from "../../shared/ogCard";

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
// type expects (`key` included, which is what makes it a ReactElement to TS).
// Everything is a flex <div>; leaves hold text.
type Vnode = {
  type: "div";
  props: { style: Record<string, unknown>; children?: unknown };
  key: string | null;
};
const el = (style: Record<string, unknown>, children?: unknown, key: string | null = null): Vnode => ({
  type: "div",
  props: { style: { display: "flex", ...style }, children },
  key,
});

function cardVnode(m: OgCardModel): Vnode {
  // Three steps by length, not measurement: satori wraps and (past two lines)
  // ellipsizes for us, so the size only has to keep short names monumental and
  // long ones from eating the figure's room.
  const titleSize = m.title.length <= 18 ? 76 : m.title.length <= 44 ? 60 : 48;
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
      // the top strip: the site bar's brand on the left, same treatment
      // (.t-label .brand — sentence case, 600), and the favicon's M mark holding
      // the opposite corner. flex-start so the mark hangs from the top edge the
      // way the wordmark sits on it, rather than centering against 30px text.
      el({ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }, [
        el({ fontWeight: 600, fontSize: 30 }, "Mahonia"),
        {
          type: "img",
          props: {
            src: MARK_SRC,
            width: MARK_SIZE,
            height: MARK_SIZE,
            style: { width: MARK_SIZE, height: MARK_SIZE },
          },
          key: null,
        },
      ]),
      el(
        {
          // block + lineClamp is satori's text-truncation mode: two lines, then "…"
          display: "block",
          lineClamp: 2,
          marginTop: 40,
          fontFamily: "InterDisplay",
          fontWeight: 700,
          fontSize: titleSize,
          lineHeight: 1.1,
          letterSpacing: TRACK_TIGHT,
          wordBreak: "break-word",
        },
        m.title,
      ),
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
        ? el(
            { flexDirection: "row", marginTop: 30 },
            m.chips.map((c, i) =>
              el(
                { marginLeft: i ? 44 : 0, fontSize: 35 },
                [el({ fontWeight: 600, color: INK_2 }, c.label), el({ marginLeft: 12 }, c.value)],
                c.label,
              ),
            ),
          )
        : null,
    ],
  );
}

/** The card as SVG — the testable middle step (deterministic string out). */
export function ogCardSvg(m: OgCardModel, fonts: SatoriOptions["fonts"]): Promise<string> {
  return satori(cardVnode(m), { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT, fonts });
}

/** The card as PNG bytes, ready to serve. */
export async function renderOgCard(
  m: OgCardModel,
  fonts: SatoriOptions["fonts"],
): Promise<Buffer> {
  return new Resvg(await ogCardSvg(m, fonts)).render().asPng();
}
