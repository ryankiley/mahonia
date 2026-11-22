import { glyph, line } from "./parts";

/** A mitt with its thumb out, on a cuff: gloves and mitts. Set 1.5 units left of the
 *  mitt's own middle so the whole of it, thumb included, is centred on the grid; centred
 *  on the mitt, the thumb pulled it right. */
export const GloveGlyph = glyph(
  line("M6 17V7C6 4.79 7.79 3 10 3C12.21 3 14 4.79 14 7V11.5L15.4 10.1C16.2 9.3 17.5 9.3 18.3 10.1C19.1 10.9 19.1 12.2 18.3 13L14.5 16.8"),
  line("M5 17H15V19.5C15 20.33 14.33 21 13.5 21H6.5C5.67 21 5 20.33 5 19.5V17Z"),
);
