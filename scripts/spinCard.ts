// /trail-spin's link preview: the page's first frame, the example route turned an eighth of the way
// round, white on black, and nothing else. No words and no mark: the title, the description
// and the site's name under a preview already say what it is and whose, and a line reads at
// any size a preview is shown at.
//
// Drawn as an SVG from the same projection the stage draws with (shared/routeSpin.ts) and
// rasterized by resvg, as the site card is. public/og-trail-spin.png is COMMITTED, written by
// `npm run og:spin` (scripts/render-og-spin.ts); tests/spinCard.test.ts re-renders it and
// compares bytes, so a change to the drawing or the example that forgets the regen is a red
// test rather than a stale preview.
import { Resvg } from "@resvg/resvg-js";
import { spinExampleTrack } from "../app/data/spinExample";
import { OG_IMAGE_HEIGHT as SPIN_CARD_HEIGHT, OG_IMAGE_WIDTH as SPIN_CARD_WIDTH } from "../shared/ogCard";
import { pitchFor, projectSpin, SPIN_START_ANGLE, spinModel } from "../shared/routeSpin";
/** The box this one frame fills, centred on the card. A still has no turn to keep room for,
 *  so it's the frame's own extent that fits, not the whole turn's the stage and the video
 *  allow for. */
const ROUTE_BOX = { width: 1000, height: 460 };
/** Heavier than the video's line at this size: a preview is mostly seen as a thumbnail. */
const LINE_PX = 3;

function spinCardSvg(): string {
  const m = spinModel(spinExampleTrack());
  if (!m) throw new Error("the example has no line");
  const xy = projectSpin(m, SPIN_START_ANGLE, pitchFor(m));
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (let i = 0; i < xy.length; i += 2) {
    left = Math.min(left, xy[i]!);
    right = Math.max(right, xy[i]!);
    bottom = Math.min(bottom, xy[i + 1]!);
    top = Math.max(top, xy[i + 1]!);
  }
  const scale = Math.min(ROUTE_BOX.width / (right - left), ROUTE_BOX.height / (top - bottom));
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  let d = "";
  for (let i = 0; i < m.e.length; i++) {
    const x = SPIN_CARD_WIDTH / 2 + (xy[2 * i]! - midX) * scale;
    const y = SPIN_CARD_HEIGHT / 2 - (xy[2 * i + 1]! - midY) * scale;
    d += `${m.starts[i] ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SPIN_CARD_WIDTH}" height="${SPIN_CARD_HEIGHT}">`,
    `<rect width="100%" height="100%" fill="#000"/>`,
    `<path d="${d}" fill="none" stroke="#fff" stroke-width="${LINE_PX}" stroke-linejoin="round" stroke-linecap="round"/>`,
    `</svg>`,
  ].join("");
}

export function renderSpinCard(): Buffer {
  return new Resvg(spinCardSvg(), { font: { loadSystemFonts: false } }).render().asPng();
}
