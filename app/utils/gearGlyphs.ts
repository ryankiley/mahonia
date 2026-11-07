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
// poles, a jacket (it has no jacket at all), a water bottle, a canister stove and a
// toiletry tube.
// Everything else is a Hugeicons glyph, several of them Ryan's picks made while
// reviewing these drawings: Chocolate for food, Hat, Glasses,
// Shirt01, Sneaker, MoneyBag01 for every bag, Energy for electronics, WaterEnergy for
// a filter. app/utils/gearIcons.ts joins name to icon.

const line = (d: string): IconChild => [
  "path",
  { d, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5" },
];
const glyph = (...children: IconChild[]): IconNode => children;

/** The mummy, after Ryan's sketch: an egg-shaped bag, the face opening as a soft
 *  window, the hood's edge sweeping from it to the side, two baffles floating below. */
export const SleepingBagGlyph = glyph(
  line("M12 2C15.2 2 17.6 4.3 17.6 7.5C17.6 11 17.2 14.5 16.3 17.8C15.6 20.3 14 22 12 22C10 22 8.4 20.3 7.7 17.8C6.8 14.5 6.4 11 6.4 7.5C6.4 4.3 8.8 2 12 2Z"),
  line("M10.1 4.4H13.9C14.67 4.4 15.3 5.03 15.3 5.8V7.2C15.3 7.97 14.67 8.6 13.9 8.6H10.1C9.33 8.6 8.7 7.97 8.7 7.2V5.8C8.7 5.03 9.33 4.4 10.1 4.4Z"),
  line("M13.9 8.6C15.9 8.6 17.58 9.45 17.49 10.65"),
  line("M8.9 12.7C10.9 13.05 13 13.05 15 12.7"),
  line("M9.6 16.3C11.2 16.55 12.8 16.55 14.4 16.3"),
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

/** A canister stove, after Ryan's sketch: the domed gas can, the burner on it, the stem
 *  rising into a teardrop flame, and the pot supports reaching out flat. */
export const StoveGlyph = glyph(
  line("M4.6 22H19.4C19.73 22 20 21.73 20 21.4V18C20 15.2 17.5 12.84 14 12.84H10C6.5 12.84 4 15.2 4 18V21.4C4 21.73 4.27 22 4.6 22Z"),
  line("M8 12.84V10.27C8 9.5 8.63 8.87 9.4 8.87H14.6C15.37 8.87 16 9.5 16 10.27V12.84"),
  line("M12 5.7V8.87"),
  line("M12 2C13.3 3.3 14.15 4.5 14.15 5.3C14.15 6.2 13.2 6.85 12 6.85C10.8 6.85 9.85 6.2 9.85 5.3C9.85 4.5 10.7 3.3 12 2Z"),
  line("M7.3 5.3H3.6L8 10.8"),
  line("M16.7 5.3H20.4L16 10.8"),
);
