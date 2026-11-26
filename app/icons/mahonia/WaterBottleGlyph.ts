import { glyph, line } from "./parts";

/** A water bottle: a cap, a short neck and shoulders built like the canister's (Central's
 *  jar), and a label band. Central's own IconBottle has a long narrow neck and no cap, and
 *  beside the gear it read as a vase. */
export const WaterBottleGlyph = glyph(
  line("M10.5 5.5H13.5C14.33 5.5 15 4.83 15 4V3.5C15 2.67 14.33 2 13.5 2H10.5C9.67 2 9 2.67 9 3.5V4C9 4.83 9.67 5.5 10.5 5.5Z"),
  line("M10 5.5V6.2C10 7 9.6 7.7 9 8.2L8 9C7.37 9.5 7 10.27 7 11.07V19C7 20.66 8.34 22 10 22H14C15.66 22 17 20.66 17 19V11.07C17 10.27 16.63 9.5 16 9L15 8.2C14.4 7.7 14 7 14 6.2V5.5"),
  line("M7 13.5H17"),
);
