import { glyph, line } from "./parts";

/** A jacket, hood up, zip down the middle: every layer that goes over a shirt. */
export const JacketGlyph = glyph(
  line("M9 4.5L5 6.2C3.8 6.7 3 7.9 3 9.2V18C3 18.55 3.45 19 4 19H7V19.5C7 20.88 8.12 22 9.5 22H14.5C15.88 22 17 20.88 17 19.5V19H20C20.55 19 21 18.55 21 18V9.2C21 7.9 20.2 6.7 19 6.2L15 4.5"),
  line("M9 4.5C9 3.12 10.34 2 12 2C13.66 2 15 3.12 15 4.5"),
  line("M9 4.5C9.5 6.2 10.6 7.2 12 7.2C13.4 7.2 14.5 6.2 15 4.5"),
  line("M7 10V19"),
  line("M17 10V19"),
  line("M12 7.2V22"),
);
