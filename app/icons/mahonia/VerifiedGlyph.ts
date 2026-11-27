import { IconFormSeal } from "../central/IconFormSeal";
import { glyph, line } from "./parts";

/** A seal with a tick in it: a figure someone has checked. Central draws the seal
 *  (IconFormSeal) and ticks inside a circle and a shield, but no verified badge, so this
 *  is its seal with the tick its shield carries, set on the seal's centre. */
export const VerifiedGlyph = glyph(...IconFormSeal, line("M9.5 12.25L11 13.75L14.5 10.25"));
