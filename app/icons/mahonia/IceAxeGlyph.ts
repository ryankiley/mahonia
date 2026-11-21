import { glyph, line } from "./parts";

/** An ice axe, traced from a reference in review: one outline from the adze's blunt end
 *  over the long arched head to the pick's point, back under it to the straight shaft,
 *  down to the wider rounded grip and up again, with two dots for the grip's texture.
 *  The head is left plain (the reference's hole, slot and teeth fill a head this
 *  shallow in at 20px, and were simplified away in review). */
export const IceAxeGlyph = glyph(
  line("M3.2 3.6C5.2 2.6 7.8 1.9 10 1.85C13.7 1.8 17.7 3.5 20.8 5.9L20.2 7.4C18.9 6.6 16.8 5.8 15.1 5.8C13.6 5.8 12.2 6.3 11.15 6.6V12.4H11.15C11.6 12.4 11.95 12.75 11.95 13.2V19.7C11.95 20.97 10.92 22 9.65 22C8.38 22 7.35 20.97 7.35 19.7V13.2C7.35 12.75 7.7 12.4 8.15 12.4V6.6C6.7 6.2 5 6 3.5 6.1L3.2 3.6Z"),
  line("M9.65 15.4H9.66"),
  line("M9.65 18.6H9.66"),
);
