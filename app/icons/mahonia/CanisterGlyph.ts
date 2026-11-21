import { glyph, line } from "./parts";

/** A lidded canister: a bear canister, a jar or a cooler, sealed. */
export const CanisterGlyph = glyph(
  line("M7.5 2H16.5C17.33 2 18 2.67 18 3.5V4C18 4.83 17.33 5.5 16.5 5.5H7.5C6.67 5.5 6 4.83 6 4V3.5C6 2.67 6.67 2 7.5 2Z"),
  line("M7 5.5L5.6 7.6C5.2 8.2 5 8.9 5 9.6V19C5 20.66 6.34 22 8 22H16C17.66 22 19 20.66 19 19V9.6C19 8.9 18.8 8.2 18.4 7.6L17 5.5"),
);
