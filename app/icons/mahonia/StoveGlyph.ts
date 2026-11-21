import { glyph, line } from "./parts";

/** A canister stove, after Ryan's sketch: the domed gas can, the burner on it, a
 *  teardrop flame above, and the pot supports reaching out flat. */
export const StoveGlyph = glyph(
  line("M6.5 22H17.5C18.88 22 20 20.88 20 19.5V19C20 16.79 17.31 15 14 15H10C6.69 15 4 16.79 4 19V19.5C4 20.88 5.12 22 6.5 22Z"),
  line("M8.5 15V13C8.5 12.45 8.95 12 9.5 12H14.5C15.05 12 15.5 12.45 15.5 13V15"),
  line("M12 2C14 3.9 15.2 5.6 15.2 7C15.2 8.5 13.8 9.4 12 9.4C10.2 9.4 8.8 8.5 8.8 7C8.8 5.6 10 3.9 12 2Z"),
  line("M6.3 7.2H3.5L8.5 12"),
  line("M17.7 7.2H20.5L15.5 12"),
);
