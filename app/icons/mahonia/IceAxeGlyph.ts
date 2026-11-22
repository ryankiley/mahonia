import { glyph, line } from "./parts";

/** An ice axe, traced from a reference in review: one outline from the adze's blunt end
 *  over the long arched head to the pick's point, back under it to the straight shaft,
 *  down to the wider rounded grip and up again. The pick's tip and the adze's corners are
 *  rounded, and the grip is plain: two texture dots filled its narrow counter in at 18px.
 *  (The reference's hole, slot and teeth went the same way in the first review.) */
export const IceAxeGlyph = glyph(
  line("M3.75 3.4C5.5 2.5 7.8 1.9 10 1.85C13.7 1.8 17.7 3.5 20.8 5.9C21.6 6.5 21.05 7.9 20.2 7.4C18.9 6.6 16.8 5.8 15.1 5.8C13.6 5.8 12.2 6.3 11.15 6.6V12.4C11.6 12.4 11.95 12.75 11.95 13.2V19.7C11.95 20.97 10.92 22 9.65 22C8.38 22 7.35 20.97 7.35 19.7V13.2C7.35 12.75 7.7 12.4 8.15 12.4V6.6C6.7 6.2 5.2 6.05 4.3 6.05C3.7 6.05 3.35 5.7 3.3 5.1L3.2 4.4C3.15 3.95 3.4 3.6 3.75 3.4Z"),
);
