import { glyph, line } from "./parts";

/** Two peaks: elevation. One outline, every corner rounded the way Central rounds a
 *  triangle's, and the front peak's flank running on a little way behind the junction so
 *  the two read as one in front of the other. */
export const MountainGlyph = glyph(
  line("M3.95 15.61L8.16 7.18C8.71 6.08 10.29 6.08 10.84 7.18L13.43 12.36L14.57 10.65C15.21 9.69 16.64 9.78 17.16 10.81L19.55 15.61C20.22 16.94 19.25 18.5 17.76 18.5L5.74 18.5C4.25 18.5 3.28 16.94 3.95 15.61Z"),
  line("M13.43 12.36L14.5 14.5"),
);
