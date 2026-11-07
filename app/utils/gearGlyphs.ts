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
// poles, a jacket (it has no jacket at all), a water bottle, a canister stove, a
// toiletry tube, a headlamp, a carabiner, a hiking boot and a neck gaiter.
// Everything else is a Hugeicons glyph, several of them Ryan's picks made while
// reviewing these drawings: Chocolate for food, Hat, Glasses,
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

/** The mummy, from a sketch in review: an egg-shaped bag, the face opening as a soft
 *  window, one baffle below. */
export const SleepingBagGlyph = glyph(
  line("M12 2C15.2 2 17.6 4.3 17.6 7.5C17.6 11 17.2 14.5 16.3 17.8C15.6 20.3 14 22 12 22C10 22 8.4 20.3 7.7 17.8C6.8 14.5 6.4 11 6.4 7.5C6.4 4.3 8.8 2 12 2Z"),
  line("M10.1 4.4H13.9C14.67 4.4 15.3 5.03 15.3 5.8V7.2C15.3 7.97 14.67 8.6 13.9 8.6H10.1C9.33 8.6 8.7 7.97 8.7 7.2V5.8C8.7 5.03 9.33 4.4 10.1 4.4Z"),
  line("M8.9 13.5C10.9 13.85 13.1 13.85 15.1 13.5"),
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

/** A canister stove, after Ryan's sketch: the domed gas can, the burner on it, a
 *  teardrop flame above, and the pot supports reaching out flat. */
export const StoveGlyph = glyph(
  line("M4.6 22H19.4C19.73 22 20 21.73 20 21.4V19.2C20 16.8 17.6 14.9 14.4 14.9H9.6C6.4 14.9 4 16.8 4 19.2V21.4C4 21.73 4.27 22 4.6 22Z"),
  line("M8.5 14.9V12.8C8.5 12.14 9.04 11.6 9.7 11.6H14.3C14.96 11.6 15.5 12.14 15.5 12.8V14.9"),
  line("M12 2C14 3.9 15.2 5.6 15.2 7C15.2 8.5 13.8 9.4 12 9.4C10.2 9.4 8.8 8.5 8.8 7C8.8 5.6 10 3.9 12 2Z"),
  line("M6.3 7.2H3.4L8.5 13.2"),
  line("M17.7 7.2H20.6L15.5 13.2"),
);

/** A headlamp: the lamp and its lens, on its strap. */
export const HeadlampGlyph = glyph(
  line("M10 7H14C15.66 7 17 8.34 17 10V14C17 15.66 15.66 17 14 17H10C8.34 17 7 15.66 7 14V10C7 8.34 8.34 7 10 7Z"),
  ring(12, 12, 1.75),
  line("M7 12H2.5"),
  line("M17 12H21.5"),
);

/** A carabiner: a D, its spine straight, its gate swung open. */
export const CarabinerGlyph = glyph(
  line("M17 7.5V6C17 3.79 15.21 2 13 2H11C8.79 2 7 3.79 7 6V18C7 20.21 8.79 22 11 22H13C15.21 22 17 20.21 17 18V16.5"),
  line("M17 16.5L12.8 9.8"),
);

/** A hiking boot from the side, from a sketch in review: the straight back of the shaft,
 *  the padded collar, the tongue sweeping up, three eyelets down the front, the toe,
 *  and a sole with its arch notch. */
export const HikingBootGlyph = glyph(
  line("M2.3 18.15V4.45C2.3 3.9 2.75 3.45 3.3 3.45H8.2C8.8 2.6 9.8 2 11 2C11.9 2 12.5 2.6 12.4 3.3C12.3 3.8 11.9 4.2 11.6 4.7C11.2 5.4 11 6.2 11.2 7C11.7 9 13.3 10.7 15.6 11.6C16.6 12 17.6 12.1 18.6 12.1H19.2C20.7 12.1 21.9 13.3 21.9 14.8V18.15H2.3Z"),
  line("M2.3 7.1L6.6 6.1L8.2 3.45"),
  line("M9.13 8.5H9.14"),
  line("M10.6 11H10.61"),
  line("M12.9 12.95H12.91"),
  line("M2.3 18.15V20.6C2.3 21.16 2.78 21.62 3.35 21.62H7.9L9.05 20.2L10.1 20.95C10.4 21.4 10.9 21.62 11.4 21.62H20.9C21.45 21.62 21.9 21.17 21.9 20.6V18.15"),
);

/** A neck gaiter, worn: the tube pulled up over the neck and chin. Neckwear of every
 *  kind wears it (buffs, bandanas, balaclavas, headbands, scarves). */
export const NeckGaiterGlyph = glyph(
  line("M8 8.5C8 6.01 9.79 4 12 4C14.21 4 16 6.01 16 8.5"),
  line("M7.5 9H16.5V14.5C16.5 15.6 14.5 16.5 12 16.5C9.5 16.5 7.5 15.6 7.5 14.5V9Z"),
  line("M4 21.5C4 19.5 5.6 18 8 17.6"),
  line("M20 21.5C20 19.5 18.4 18 16 17.6"),
);
