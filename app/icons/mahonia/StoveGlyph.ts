import { glyph, line } from "./parts";

/** A canister stove, after Ryan's sketch: the domed gas can, a stem up to the pot
 *  supports, and a teardrop flame above them. The supports are one shallow cradle; drawn
 *  as arms reaching out flat they made the whole glyph read as a figure with its hands up. */
export const StoveGlyph = glyph(
  line("M12 2C14 3.7 15 5.2 15 6.6C15 8.1 13.7 9.1 12 9.1C10.3 9.1 9 8.1 9 6.6C9 5.2 10 3.7 12 2Z"),
  line("M4 9.5V12C4 12.55 4.45 13 5 13H19C19.55 13 20 12.55 20 12V9.5"),
  line("M12 13V16"),
  line("M6.5 21.5H17.5C18.88 21.5 20 20.38 20 19C20 17.34 17.31 16 14 16H10C6.69 16 4 17.34 4 19C4 20.38 5.12 21.5 6.5 21.5Z"),
);
