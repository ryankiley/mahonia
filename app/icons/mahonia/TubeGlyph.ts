import { glyph, line } from "./parts";

/** A tube standing on its cap: sunscreen, toothpaste, cream. */
export const TubeGlyph = glyph(
  line("M6.5 2.5H17.5"),
  line("M7 2.5L8.6 16.2C8.75 17.24 9.63 18 10.67 18H13.33C14.37 18 15.25 17.24 15.4 16.2L17 2.5"),
  line("M7.5 6.5H16.5"),
  line("M9.5 18V20C9.5 21.1 10.4 22 11.5 22H12.5C13.6 22 14.5 21.1 14.5 20V18"),
);
