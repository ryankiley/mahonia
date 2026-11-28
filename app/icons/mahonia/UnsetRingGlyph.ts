import type { IconNode } from "../../utils/icon";

/** A dashed ring: nothing set here yet. The editor row's class mark wears it on a base
 *  row, where the lit plate sits once the row is worn or consumable — the outline of the
 *  plate, empty. Ten round-capped dashes on a radius of 8.25, the gap twice the dash, so
 *  it reads as dashes at the 1.25px line the app draws and not as a dotted full circle. */
export const UnsetRingGlyph: IconNode = [
  ["circle", { cx: "12", cy: "12", r: "8.25", stroke: "currentColor", "stroke-linecap": "round", "stroke-dasharray": "1.7 3.484" }],
];
