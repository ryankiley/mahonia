import type { IconChild, IconNode } from "../../utils/icon";

// The pieces every glyph here is built from: a stroked path and a ring, round-capped and
// round-joined, with no stroke width of their own (the <svg> carries it; see ./index.ts).
export const line = (d: string): IconChild => ["path", { d, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" }];
export const ring = (cx: number, cy: number, r: number): IconChild => [
  "circle",
  { cx: String(cx), cy: String(cy), r: String(r), stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" },
];
export const glyph = (...children: IconChild[]): IconNode => children;
