import type { IconChild, IconNode } from "./hugeicon";

// Gear the Hugeicons free set has no picture for, drawn in its grammar so the two read
// as one family: a 24-unit grid with the art inside 2–22, outline strokes only, round
// caps and joins, soft corners, and no two strokes closer than about three units — the
// app draws icons at stroke 2, so a 16px glyph's lines are 1.33px and anything tighter
// fills in. Each glyph is the same data shape as an @hugeicons/core-free-icons export,
// so <HugeiconsIcon :icon> draws it unchanged (the stroke width is stamped at render).
//
// What's here is the core of a pack the free set skips: sleep (quilt, mummy bag),
// shelter (tarp, bivy, groundsheet, stakes, poles), the jackets (it has no jacket at
// all), water (bottle, soft flask, reservoir, filter), bags (stuff sack,
// pouch, zip bag, hip pack), and the small kit a list is full of (beanie, neck
// gaiter, headlamp, gas canister, carabiner, tube, stick). Wherever Hugeicons has
// the thing, its glyph is used instead (Ryan picked several: Airpod03 for earbuds,
// Bug02 for a head net, DentalTooth, Fire02 for a stove, Chocolate for a bar, Hat,
// MoneyBag01 for a dry bag).
// Which gear type wears which glyph is shared/gearGlyph.ts; app/utils/gearIcons.ts
// joins the two. This file is only the drawings.

const line = (d: string): IconChild => [
  "path",
  { d, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "1.5" },
];
const ring = (cx: number, cy: number, r: number): IconChild => [
  "circle",
  { cx: String(cx), cy: String(cy), r: String(r), stroke: "currentColor", strokeWidth: "1.5" },
];
const glyph = (...children: IconChild[]): IconNode => children;

/** A quilt laid out: wide at the shoulders, tapering to the footbox, baffles across. */
export const QuiltGlyph = glyph(
  line("M5 5L18 7.5C20.49 7.5 22 9.51 22 12C22 14.49 20.49 16.5 18 16.5L5 19C3.9 19 3 18.1 3 17V7C3 5.9 3.9 5 5 5Z"),
  line("M8.5 5.8V18.2"),
  line("M14 6.9V17.1"),
);

/** The mummy: a hood with its face opening, tapering to the foot. */
export const SleepingBagGlyph = glyph(
  line("M12 2C14.8 2 17 3.9 17 6.6C17 9.6 16.4 13 16 16.2L15.6 20C15.5 21.1 14.6 22 13.5 22H10.5C9.4 22 8.5 21.1 8.4 20L8 16.2C7.6 13 7 9.6 7 6.6C7 3.9 9.2 2 12 2Z"),
  ring(12, 6.5, 2),
  line("M7.4 12.5H16.6"),
  line("M8 17H16"),
);



/** A pair: grips, shafts, baskets. */
export const TrekkingPolesGlyph = glyph(
  line("M7.75 2V8.5"),
  line("M7.75 8.5V21.5"),
  line("M16.25 2V21.5"),
  line("M5.75 18H9.75"),
  line("M14.25 18H18.25"),
  line("M6.25 2.5H9.25V8H6.25V2.5Z"),
  line("M14.75 2.5H17.75V8H14.75V2.5Z"),
);

// The jacket body both jackets share: shoulders, sleeves to the cuff, a hem.
const JACKET_BODY = "M8.5 4.2L5.3 5.7C4.1 6.3 3.3 7.5 3.3 8.8L3 19C3 19.6 3.4 20 4 20H6.5V21C6.5 21.6 6.9 22 7.5 22H16.5C17.1 22 17.5 21.6 17.5 21V20H20C20.6 20 21 19.6 21 19L20.7 8.8C20.7 7.5 19.9 6.3 18.7 5.7L15.5 4.2";

/** A shell: hood up, zip down the middle. Rain, wind, softshell. */
export const JacketGlyph = glyph(
  line(JACKET_BODY),
  line("M8.5 4.2C8.5 3 10.1 2 12 2C13.9 2 15.5 3 15.5 4.2"),
  line("M8.5 4.2C9 6 10.3 7.2 12 7.2C13.7 7.2 15 6 15.5 4.2"),
  line("M6.5 9.5V20"),
  line("M17.5 9.5V20"),
  line("M12 7.2V22"),
);

/** Insulation: a collar instead of a hood, and the baffles across. */
export const PuffyGlyph = glyph(
  line(JACKET_BODY),
  line("M8.5 4.2C9.2 5.4 10.5 6.1 12 6.1C13.5 6.1 14.8 5.4 15.5 4.2"),
  line("M6.5 9.5V20"),
  line("M17.5 9.5V20"),
  line("M12 6.1V22"),
  line("M6.5 12H17.5"),
  line("M6.5 16H17.5"),
);

/** A narrow-mouth bottle: cap, shoulders, a label band. */
export const WaterBottleGlyph = glyph(
  line("M10 4.5V3C10 2.45 10.45 2 11 2H13C13.55 2 14 2.45 14 3V4.5"),
  line("M9.5 4.5H14.5C14.5 5.6 17 6.3 17 8.6V19.5C17 20.88 15.88 22 14.5 22H9.5C8.12 22 7 20.88 7 19.5V8.6C7 6.3 9.5 5.6 9.5 4.5Z"),
  line("M7 11.5H17"),
);

/** A soft flask: the valve, and a body pinched where a hand squeezes it. */
export const SoftFlaskGlyph = glyph(
  line("M10.5 4V3C10.5 2.45 10.95 2 11.5 2H12.5C13.05 2 13.5 2.45 13.5 3V4"),
  line("M10 4H14C14 5.8 17.5 6.5 17.5 9.5C17.5 11.5 16.5 12.5 16.5 14C16.5 15.5 18 16.5 18 18.5C18 20.43 16.43 22 14.5 22H9.5C7.57 22 6 20.43 6 18.5C6 16.5 7.5 15.5 7.5 14C7.5 12.5 6.5 11.5 6.5 9.5C6.5 6.5 10 5.8 10 4Z"),
);

/** A hydration reservoir: the bag, its slide seal, the hose to the bite valve. */
export const ReservoirGlyph = glyph(
  line("M7 4H14C15.1 4 16 4.9 16 6V19C16 20.66 14.66 22 13 22H8C6.34 22 5 20.66 5 19V6C5 4.9 5.9 4 7 4Z"),
  line("M5 8H16"),
  line("M16 18H17.5C19.43 18 21 16.43 21 14.5V5.5"),
  line("M20 3C20 2.45 20.45 2 21 2C21.55 2 22 2.45 22 3V5.5H20V3Z"),
);

/** A squeeze filter: the cartridge, and clean water out of the bottom. */
export const WaterFilterGlyph = glyph(
  line("M9.5 2.5H14.5C15.33 2.5 16 3.17 16 4V11.5C16 12.33 15.33 13 14.5 13H9.5C8.67 13 8 12.33 8 11.5V4C8 3.17 8.67 2.5 9.5 2.5Z"),
  line("M8 6H16"),
  line("M8 9.5H16"),
  line("M12 13V14.25"),
  line("M12 16.5C12 16.5 9.75 19 9.75 20C9.75 21.1 10.76 22 12 22C13.24 22 14.25 21.1 14.25 20C14.25 19 12 16.5 12 16.5Z"),
);

/** A stuff sack: the body, the cinched neck, the cord lock. */
export const StuffSackGlyph = glyph(
  line("M8.5 7C6.4 8.6 5 11.2 5 14.5V18.5C5 20.43 6.57 22 8.5 22H15.5C17.43 22 19 20.43 19 18.5V14.5C19 11.2 17.6 8.6 15.5 7H8.5Z"),
  line("M9.5 7L10.5 3.5H13.5L14.5 7"),
  line("M12 7V9"),
  line("M11 10C11 9.45 11.45 9 12 9C12.55 9 13 9.45 13 10V11C13 11.55 12.55 12 12 12C11.45 12 11 11.55 11 11V10Z"),
);


/** A zip pouch — toiletries, wallets, the small bag that holds the small things. */
export const PouchGlyph = glyph(
  line("M7 6H17C18.66 6 20 7.34 20 9V16C20 17.66 18.66 19 17 19H7C5.34 19 4 17.66 4 16V9C4 7.34 5.34 6 7 6Z"),
  line("M4.3 10H19.7"),
  line("M16 10V13"),
);

/** A zip-top bag: food bags, odor-proof bags, the trash bag. */
export const ZipBagGlyph = glyph(
  line("M5 3H19C19.55 3 20 3.45 20 4V19C20 20.66 18.66 22 17 22H7C5.34 22 4 20.66 4 19V4C4 3.45 4.45 3 5 3Z"),
  line("M4 7H20"),
  line("M7.5 7V9.5"),
);

/** A hip pack: the pouch and its belt. */
export const HipPackGlyph = glyph(
  line("M7 8H17C18.66 8 20 9.34 20 11V15C20 17.21 18.21 19 16 19H8C5.79 19 4 17.21 4 15V11C4 9.34 5.34 8 7 8Z"),
  line("M2 11H4"),
  line("M20 11H22"),
  line("M4.3 12.5H19.7"),
);

/** A beanie: the crown, the folded cuff with its ribs, the pom. */
export const BeanieGlyph = glyph(
  line("M5 15C5 10.3 8.13 6.5 12 6.5C15.87 6.5 19 10.3 19 15"),
  line("M4.5 15H19.5C20.33 15 21 15.67 21 16.5V18.5C21 19.33 20.33 20 19.5 20H4.5C3.67 20 3 19.33 3 18.5V16.5C3 15.67 3.67 15 4.5 15Z"),
  ring(12, 4.5, 2),
  line("M8 15V20"),
  line("M12 15V20"),
  line("M16 15V20"),
);



/** A neck gaiter, worn: the tube pulled up over the neck and chin. */
export const NeckGaiterGlyph = glyph(
  line("M8 8.5C8 6.01 9.79 4 12 4C14.21 4 16 6.01 16 8.5"),
  line("M7.5 9H16.5V14.5C16.5 15.6 14.5 16.5 12 16.5C9.5 16.5 7.5 15.6 7.5 14.5V9Z"),
  line("M4 21.5C4 19.5 5.6 18 8 17.6"),
  line("M20 21.5C20 19.5 18.4 18 16 17.6"),
);




/** A tarp pitched as an A-frame, seen from the front corner. */
export const TarpGlyph = glyph(
  line("M2.5 19L8.5 8L14.5 19"),
  line("M8.5 8L19 5.5L21.5 15.5L14.5 19"),
  line("M2 19H15"),
);

/** A bivy: a low shelter you sleep in, its one hoop over your head. */
export const BivyGlyph = glyph(
  line("M2.5 19.5H21.5"),
  line("M2.5 19.5C2.5 17.5 3.6 16 6 15.2L14.4 12.2C16.6 11.4 19 12.1 20.2 14C21 15.3 21.5 17.2 21.5 19.5"),
  line("M15.2 11.95C15.9 14.4 15.9 17 15.4 19.5"),
);

/** A groundsheet: a sheet laid flat on the ground. */
export const GroundsheetGlyph = glyph(
  line("M6.2 7H20.6C21.3 7 21.8 7.7 21.55 8.35L18.75 16.3C18.6 16.72 18.2 17 17.8 17H3.4C2.7 17 2.2 16.3 2.45 15.65L5.25 7.7C5.4 7.28 5.8 7 6.2 7Z"),
);

/** A stake: the head, and the beam narrowing to its point. */
export const TentStakeGlyph = glyph(
  line("M8.5 4H15.5"),
  line("M9.5 4L12 21L14.5 4"),
);

/** A carabiner: a D, its spine straight, its gate swung open. */
export const CarabinerGlyph = glyph(
  line("M17 7.5V6C17 3.79 15.21 2 13 2H11C8.79 2 7 3.79 7 6V18C7 20.21 8.79 22 11 22H13C15.21 22 17 20.21 17 18V16.5"),
  line("M17 16.5L12.8 9.8"),
);

/** A headlamp: the lamp and its lens, on its strap. */
export const HeadlampGlyph = glyph(
  line("M10 7H14C15.66 7 17 8.34 17 10V14C17 15.66 15.66 17 14 17H10C8.34 17 7 15.66 7 14V10C7 8.34 8.34 7 10 7Z"),
  ring(12, 12, 2.5),
  line("M7 12H2.5"),
  line("M17 12H21.5"),
);


/** A gas canister: squat, domed, the valve on top. */
export const CanisterGlyph = glyph(
  line("M5 12.5C5 10.01 8.13 8 12 8C15.87 8 19 10.01 19 12.5V19.5C19 20.88 17.88 22 16.5 22H7.5C6.12 22 5 20.88 5 19.5V12.5Z"),
  line("M10.5 8V5.5C10.5 4.95 10.95 4.5 11.5 4.5H12.5C13.05 4.5 13.5 4.95 13.5 5.5V8"),
  line("M5 15.5H19"),
);


/** A tube standing on its cap: sunscreen, toothpaste, cream. */
export const TubeGlyph = glyph(
  line("M6.5 2.5H17.5"),
  line("M7 2.5L8.5 16.5C8.6 17.35 9.2 18 10 18H14C14.8 18 15.4 17.35 15.5 16.5L17 2.5"),
  line("M7.3 5.5H16.7"),
  line("M9.5 18V21C9.5 21.55 9.95 22 10.5 22H13.5C14.05 22 14.5 21.55 14.5 21V18"),
);

/** A twist-up stick: lip balm, sunscreen stick, deodorant. */
export const StickGlyph = glyph(
  line("M10 2H14C14.83 2 15.5 2.67 15.5 3.5V8H8.5V3.5C8.5 2.67 9.17 2 10 2Z"),
  line("M8.5 10.5H15.5V20.5C15.5 21.33 14.83 22 14 22H10C9.17 22 8.5 21.33 8.5 20.5V10.5Z"),
  line("M8.5 14H15.5"),
);
