import { glyph, line } from "./parts";

/** A jerry can, spout up, the X pressed in its side: stove fuel of every kind. Its corners
 *  are radius 3, and the 45° shoulder bends at radius 3 too, the way Central's IconBottle
 *  turns its own; the spout's small corners are radius 1. */
export const FuelCanGlyph = glyph(
  line("M8 5H12.26C13.05 5 13.82 5.32 14.38 5.88L18.12 9.62C18.68 10.18 19 10.95 19 11.74V18C19 19.66 17.66 21 16 21H8C6.34 21 5 19.66 5 18V8C5 6.34 6.34 5 8 5Z"),
  line("M15.5 7L17.04 5.46C17.43 5.07 18.07 5.07 18.46 5.46L19.54 6.54C19.93 6.93 19.93 7.57 19.54 7.96L19 8.5"),
  line("M8.5 11.5L14.5 17.5"),
  line("M14.5 11.5L8.5 17.5"),
);
