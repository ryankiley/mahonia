import type { IconChild, IconNode } from "./hugeicon";

// Gear the Hugeicons free set has no picture for, drawn in its grammar so the two read
// as one family: a 24-unit grid with the art inside 2–22, outline strokes only, round
// caps and joins, soft corners, and no two strokes closer than about three units — the
// app draws icons at stroke 2, so a 16px glyph's lines are 1.33px and anything tighter
// fills in. Each glyph is the same data shape as an @hugeicons/core-free-icons export,
// so <HugeiconsIcon :icon> draws it unchanged (the stroke width is stamped at render).
//
// What's here is what the free set has no good picture for among the icons the gear
// page uses (shared/gearGlyph.ts keeps that set small): a sleeping bag, trekking poles,
// a jacket (it has no jacket at all), a water bottle, a filter, a stuff sack and a
// toiletry tube. Everything else is a Hugeicons glyph — several of them
// Ryan's picks, made while reviewing these drawings (Airpod03, Chocolate, Hat,
// Glasses, Fire02 for the stove, Shirt01, Sneaker). app/utils/gearIcons.ts joins name to icon.

const line = (d: string): IconChild => [
  "path",
  { d, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5" },
];
const ring = (cx: number, cy: number, r: number): IconChild => [
  "circle",
  { cx: String(cx), cy: String(cy), r: String(r), stroke: "currentColor", strokeWidth: "1.5" },
];
const glyph = (...children: IconChild[]): IconNode => children;

/** The mummy: a hood with its face opening, tapering to the foot. */
export const SleepingBagGlyph = glyph(
  line("M12 2C14.8 2 17 3.9 17 6.6C17 9.6 16.4 13 16 16.2L15.6 20C15.5 21.1 14.6 22 13.5 22H10.5C9.4 22 8.5 21.1 8.4 20L8 16.2C7.6 13 7 9.6 7 6.6C7 3.9 9.2 2 12 2Z"),
  ring(12, 6.5, 2),
  line("M7.4 12.5H16.6"),
  line("M8 17H16"),
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
  line("M10 4.5V3C10 2.45 10.45 2 11 2H13C13.55 2 14 2.45 14 3V4.5"),
  line("M9.5 4.5H14.5C14.5 5.6 17 6.3 17 8.6V19.5C17 20.88 15.88 22 14.5 22H9.5C8.12 22 7 20.88 7 19.5V8.6C7 6.3 9.5 5.6 9.5 4.5Z"),
  line("M7 11.5H17"),
);

/** A squeeze filter: the cartridge, and clean water out of the bottom. */
export const WaterFilterGlyph = glyph(
  line("M9.5 2.5H14.5C15.33 2.5 16 3.17 16 4V11.5C16 12.33 15.33 13 14.5 13H9.5C8.67 13 8 12.33 8 11.5V4C8 3.17 8.67 2.5 9.5 2.5Z"),
  line("M8 7.75H16"),
  line("M12 16C12 16 9.75 18.75 9.75 19.75C9.75 20.99 10.76 22 12 22C13.24 22 14.25 20.99 14.25 19.75C14.25 18.75 12 16 12 16Z"),
);

/** A stuff sack: the body, the cinched neck, the cord lock. */
export const StuffSackGlyph = glyph(
  line("M8.5 7C6.4 8.6 5 11.2 5 14.5V18.5C5 20.43 6.57 22 8.5 22H15.5C17.43 22 19 20.43 19 18.5V14.5C19 11.2 17.6 8.6 15.5 7H8.5Z"),
  line("M9.5 7L10.5 3.5H13.5L14.5 7"),
  line("M12 7V9"),
  line("M11 10C11 9.45 11.45 9 12 9C12.55 9 13 9.45 13 10V11C13 11.55 12.55 12 12 12C11.45 12 11 11.55 11 11V10Z"),
);

/** A tube standing on its cap: sunscreen, toothpaste, cream. */
export const TubeGlyph = glyph(
  line("M6.5 2.5H17.5"),
  line("M7 2.5L8.5 16.5C8.6 17.35 9.2 18 10 18H14C14.8 18 15.4 17.35 15.5 16.5L17 2.5"),
  line("M7.3 5.5H16.7"),
  line("M9.5 18V21C9.5 21.55 9.95 22 10.5 22H13.5C14.05 22 14.5 21.55 14.5 21V18"),
);
