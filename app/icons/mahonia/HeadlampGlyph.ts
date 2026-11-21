import { glyph, line, ring } from "./parts";

/** A headlamp: the lamp and its lens, on its strap. */
export const HeadlampGlyph = glyph(
  line("M10 7H14C15.66 7 17 8.34 17 10V14C17 15.66 15.66 17 14 17H10C8.34 17 7 15.66 7 14V10C7 8.34 8.34 7 10 7Z"),
  ring(12, 12, 1.75),
  line("M7 12H2.5"),
  line("M17 12H21.5"),
);
