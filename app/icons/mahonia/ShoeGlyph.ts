import { glyph, line } from "./parts";

/** A trail runner from the side, cut low the way a sneaker is: the heel tab, the dip at
 *  the ankle, the tongue standing up, the laces sloping to a round toe with its cap, and
 *  a thick sole. Drawn with a tall flat back and no tongue it read as a slipper. */
export const ShoeGlyph = glyph(
  line("M2 15.5V9C2 7.62 3.12 6.5 4.5 6.5C5.5 6.5 6 9 7.5 9C9 9 9.4 6.9 10 5.8C10.4 5.1 11.2 4.8 11.9 5.2L18.2 9.4C20.6 11 22 12.9 22 15.5"),
  line("M2 15.5H22V17C22 18.1 21.1 19 20 19H4C2.9 19 2 18.1 2 17V15.5Z"),
  line("M13.79 6.46L12.79 7.96"),
  line("M18.2 9.4C18.2 10.6 17.4 11.6 16.3 12C15.2 12.4 14.5 13.6 14.5 15.5"),
);
