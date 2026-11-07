import type { IconChild, IconNode } from "./hugeicon";

// Gear the Hugeicons free set has no picture for, drawn in its grammar so the two read
// as one family: a 24-unit grid with the art inside 2–22, outline strokes only, round
// caps and joins, soft corners, and no two strokes closer than about three units — the
// app draws icons at stroke 2, so a 16px glyph's lines are 1.33px and anything tighter
// fills in. Each glyph is the same data shape as an @hugeicons/core-free-icons export,
// so <HugeiconsIcon :icon> draws it unchanged (the stroke width is stamped at render).
//
// What's here is what the free set has no good picture for among the icons the gear
// page uses (shared/gearGlyph.ts keeps that set small): a sleeping bag, trekking
// poles, a jacket (it has no jacket at all), a water bottle and a toiletry tube.
// Everything else is a Hugeicons glyph, several of them Ryan's picks made while
// reviewing these drawings: Chocolate for food, Hat, Glasses, Fire02 for the stove,
// Shirt01, Sneaker, MoneyBag01 for every bag, Energy for electronics, WaterEnergy for
// a filter. app/utils/gearIcons.ts joins name to icon.

const line = (d: string): IconChild => [
  "path",
  { d, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5" },
];
const ring = (cx: number, cy: number, r: number): IconChild => [
  "circle",
  { cx: String(cx), cy: String(cy), r: String(r), stroke: "currentColor", strokeWidth: "1.5" },
];
const glyph = (...children: IconChild[]): IconNode => children;

/** The mummy: a broad hood with its face opening, tapering hard to a narrow foot. */
export const SleepingBagGlyph = glyph(
  line("M12 2C14.8 2 17 3.9 17 6.6C17 10 16 14 15.1 17.5L14.55 20.2C14.35 21.25 13.45 22 12.4 22H11.6C10.55 22 9.65 21.25 9.45 20.2L8.9 17.5C8 14 7 10 7 6.6C7 3.9 9.2 2 12 2Z"),
  ring(12, 6.5, 2),
  line("M7.6 12.5H16.4"),
  line("M9.05 17H14.95"),
);

/** A pair: grips, shafts, baskets. */
export const TrekkingPolesGlyph = glyph(
  line("M7.75 8V21.5"),
  line("M16.25 8V21.5"),
  line("M5.75 18H9.75"),
  line("M14.25 18H18.25"),
  line("M6.25 2.5H9.25V8H6.25V2.5Z"),
  line("M14.75 2.5H17.75V8H14.75V2.5Z"),
);

// The jacket body: shoulders, sleeves to the cuff, a hem.
const JACKET_BODY = "M8.5 4.2L5.3 5.7C4.1 6.3 3.3 7.5 3.3 8.8L3 19C3 19.6 3.4 20 4 20H6.5V21C6.5 21.6 6.9 22 7.5 22H16.5C17.1 22 17.5 21.6 17.5 21V20H20C20.6 20 21 19.6 21 19L20.7 8.8C20.7 7.5 19.9 6.3 18.7 5.7L15.5 4.2";

/** A jacket, hood up, zip down the middle: every layer that goes over a shirt. */
export const JacketGlyph = glyph(
  line(JACKET_BODY),
  line("M8.5 4.2C8.5 3 10.1 2 12 2C13.9 2 15.5 3 15.5 4.2"),
  line("M8.5 4.2C9 6 10.3 7.2 12 7.2C13.7 7.2 15 6 15.5 4.2"),
  line("M6.5 9.5V20"),
  line("M17.5 9.5V20"),
  line("M12 7.2V22"),
);

/** A narrow-mouth bottle: cap, shoulders, a label band. */
export const WaterBottleGlyph = glyph(
  line("M10.5 2H13.5C14.33 2 15 2.67 15 3.5V5.5H9V3.5C9 2.67 9.67 2 10.5 2Z"),
  line("M9.5 5.5H14.5C14.5 6.6 17 7.3 17 9.6V19.5C17 20.88 15.88 22 14.5 22H9.5C8.12 22 7 20.88 7 19.5V9.6C7 7.3 9.5 6.6 9.5 5.5Z"),
  line("M7 12.5H17"),
);

/** A tube standing on its cap: sunscreen, toothpaste, cream. */
export const TubeGlyph = glyph(
  line("M6.5 2.5H17.5"),
  line("M7 2.5L8.5 16.5C8.6 17.35 9.2 18 10 18H14C14.8 18 15.4 17.35 15.5 16.5L17 2.5"),
  line("M7.3 5.5H16.7"),
  line("M9.5 18V21C9.5 21.55 9.95 22 10.5 22H13.5C14.05 22 14.5 21.55 14.5 21V18"),
);
