import { glyph, line } from "./parts";

/** An A-frame tent: two poles crossing at the ridge, a door, the ground. */
export const TentGlyph = glyph(
  line("M3.5 20L13 3"),
  line("M20.5 20L11 3"),
  line("M2 20H22"),
  line("M9.25 20L12 14.5L14.75 20"),
);
