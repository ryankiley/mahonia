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
      // the site bar's brand, same treatment (.t-label .brand): sentence case, 600
      el({ fontWeight: 600, fontSize: 30 }, "Mahonia"),
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
      // the big figure — number dominant, unit smaller and muted on its baseline,
      // exactly TotalsBar's totals__big + totals__unit pairing
      el({ flexDirection: "row", alignItems: "baseline" }, [
        el(
          {
            fontFamily: "InterDisplay",
            fontSize: 170,
            lineHeight: 1,
            letterSpacing: TRACK_TIGHT,
          },
          m.big.value,
        ),
        el(
          { marginLeft: 18, fontSize: 54, lineHeight: 1, color: INK_2, letterSpacing: "-0.01em" },
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
                { marginLeft: i ? 44 : 0, fontSize: 31 },
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
