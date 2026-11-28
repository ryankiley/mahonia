import { glyph, line } from "./parts";

/** The three shapes of a /trail-spin video, as the frames themselves: 16:9 wide, 9:16 vertical,
 *  and square. Drawn to one area (about 220 square units each) so none of the three
 *  reads as bigger, with the corners the app's other boxes have at this size. */
export const FrameWideGlyph = glyph(
  line("M3.5 6.5H20.5C21.33 6.5 22 7.17 22 8V16C22 16.83 21.33 17.5 20.5 17.5H3.5C2.67 17.5 2 16.83 2 16V8C2 7.17 2.67 6.5 3.5 6.5Z"),
);
export const FrameSquareGlyph = glyph(
  line("M6 4.5H18C18.83 4.5 19.5 5.17 19.5 6V18C19.5 18.83 18.83 19.5 18 19.5H6C5.17 19.5 4.5 18.83 4.5 18V6C4.5 5.17 5.17 4.5 6 4.5Z"),
);
export const FrameVerticalGlyph = glyph(
  line("M8 2H16C16.83 2 17.5 2.67 17.5 3.5V20.5C17.5 21.33 16.83 22 16 22H8C7.17 22 6.5 21.33 6.5 20.5V3.5C6.5 2.67 7.17 2 8 2Z"),
);
