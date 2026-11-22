import { glyph, line } from "./parts";

/** A canister stove, after Ryan's sketch: the domed gas can, a stem up to the pot
 *  supports, and a flame above them, the outline of Central's IconFire1 scaled down. The
 *  supports are one shallow cradle; drawn as arms reaching out flat they made the whole
 *  glyph read as a figure with its hands up. */
export const StoveGlyph = glyph(
  line("M15 6.53C15 10.36 9 10.36 9 6.53C9 3.65 12 2 12 2C12 2 15 3.65 15 6.53Z"),
  line("M4 9.5V12C4 12.55 4.45 13 5 13H19C19.55 13 20 12.55 20 12V9.5"),
  line("M12 13V16"),
  line("M6.5 21.5H17.5C18.88 21.5 20 20.38 20 19C20 17.34 17.31 16 14 16H10C6.69 16 4 17.34 4 19C4 20.38 5.12 21.5 6.5 21.5Z"),
);
