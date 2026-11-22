import { glyph, line } from "./parts";

/** A jacket, zip down the middle: every layer that goes over a shirt. Long sleeves with
 *  their seams, and one collar where the neck dips, the way Central's shirt draws it; a
 *  hood drawn as two nested arcs crowded the top at 18px. */
export const JacketGlyph = glyph(
  line("M9 4.5L5 6.2C3.8 6.7 3 7.9 3 9.2V18C3 18.55 3.45 19 4 19H7V19.5C7 20.88 8.12 22 9.5 22H14.5C15.88 22 17 20.88 17 19.5V19H20C20.55 19 21 18.55 21 18V9.2C21 7.9 20.2 6.7 19 6.2L15 4.5"),
  line("M9 4.5C9.6 6.5 10.6 7.5 12 7.5C13.4 7.5 14.4 6.5 15 4.5"),
  line("M7 10V19"),
  line("M17 10V19"),
  line("M12 7.5V22"),
);
