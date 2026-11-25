import { glyph, line } from "./parts";

/** A hiking boot from the side, from a sketch in review: the straight back of the shaft,
 *  the padded collar, the tongue sweeping up, three eyelets down the front, the toe,
 *  and a sole with its arch notch. */
export const HikingBootGlyph = glyph(
  line("M2.3 18.15V5.45C2.3 4.35 3.2 3.45 4.3 3.45H8.2C8.8 2.6 9.8 2 11 2C11.9 2 12.5 2.6 12.4 3.3C12.3 3.8 11.9 4.2 11.6 4.7C11.2 5.4 11 6.2 11.2 7C11.7 9 13.3 10.7 15.6 11.6C16.6 12 17.6 12.1 18.6 12.1H19.2C20.7 12.1 21.9 13.3 21.9 14.8V18.15H2.3Z"),
  line("M2.3 7.1L6.6 6.1L8.2 3.45"),
  line("M9.13 8.5H9.14"),
  line("M10.6 11H10.61"),
  line("M12.9 12.95H12.91"),
  line("M2.3 18.15V19.62C2.3 20.72 3.2 21.62 4.3 21.62H7.9L9.05 20.2L10.1 20.95C10.4 21.4 10.9 21.62 11.4 21.62H19.9C21 21.62 21.9 20.72 21.9 19.62V18.15"),
);
