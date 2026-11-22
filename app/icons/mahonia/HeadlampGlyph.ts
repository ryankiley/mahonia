import { glyph, line, ring } from "./parts";

/** A headlamp: the lamp and its lens, on its strap. The housing is sized so the lens can
 *  be a real ring with air around it, as Central's camera draws one; a smaller lens in a
 *  smaller box closed up into a dot at 18px. */
export const HeadlampGlyph = glyph(
  line("M8 6H16C17.66 6 19 7.34 19 9V15C19 16.66 17.66 18 16 18H8C6.34 18 5 16.66 5 15V9C5 7.34 6.34 6 8 6Z"),
  ring(12, 12, 2.5),
  line("M5 12H2"),
  line("M19 12H22"),
);
