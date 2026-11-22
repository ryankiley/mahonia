import { glyph, line } from "./parts";

/** A lidded canister: a bear canister, a jar or a cooler, sealed. Its shoulders step out
 *  at 45° with radius-3 bends, the way Central's IconBottle draws its own. */
export const CanisterGlyph = glyph(
  line("M7.5 2H16.5C17.33 2 18 2.67 18 3.5V4C18 4.83 17.33 5.5 16.5 5.5H7.5C6.67 5.5 6 4.83 6 4V3.5C6 2.67 6.67 2 7.5 2Z"),
  line("M7 5.5L5.88 6.62C5.32 7.18 5 7.95 5 8.74V19C5 20.66 6.34 22 8 22H16C17.66 22 19 20.66 19 19V8.74C19 7.95 18.68 7.18 18.12 6.62L17 5.5"),
);
