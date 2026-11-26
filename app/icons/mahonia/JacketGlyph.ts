import { glyph, line } from "./parts";

/** A jacket, zip down the middle: every layer that goes over a shirt. Long sleeves with
 *  their seams, and the neckline of Central's shirt (IconFashion, which the gear list
 *  draws shirts with) at its exact width, depth and shoulder slope, so the two sit
 *  together; a hood drawn as two nested arcs crowded the top at 18px. */
export const JacketGlyph = glyph(
  line("M9 4.1L5 5.8C3.8 6.3 3 7.5 3 8.8V18C3 18.55 3.45 19 4 19H7V19.5C7 20.88 8.12 22 9.5 22H14.5C15.88 22 17 20.88 17 19.5V19H20C20.55 19 21 18.55 21 18V8.8C21 7.5 20.2 6.3 19 5.8L15 4.1"),
  line("M9 4.1C9 4.1 9.77 6.5 12 6.5C14.23 6.5 15 4.1 15 4.1"),
  line("M7 10V19"),
  line("M17 10V19"),
  line("M12 6.5V22"),
);
