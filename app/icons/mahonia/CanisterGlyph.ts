import { glyph, line } from "./parts";

/** A lidded canister: a bear canister, a jar or a cooler, sealed. Central's own jar
 *  (IconTipjar) without its coin and slot: the same lid, a short neck under it before
 *  the shoulders step out, and the art inside 3–21 like Central's. Drawn shoulders-first
 *  from the lid's edge and 2–22 tall, it read as sitting off from the icons around it. */
export const CanisterGlyph = glyph(
  line("M7.5 6.5H16.5C17.33 6.5 18 5.83 18 5V4.5C18 3.67 17.33 3 16.5 3H7.5C6.67 3 6 3.67 6 4.5V5C6 5.83 6.67 6.5 7.5 6.5Z"),
  line("M7 6.5V7.45C7 8.13 6.77 8.79 6.34 9.32L5.66 10.18C5.23 10.71 5 11.37 5 12.05V18C5 19.66 6.34 21 8 21H16C17.66 21 19 19.66 19 18V12.05C19 11.37 18.77 10.71 18.34 10.18L17.66 9.32C17.23 8.79 17 8.13 17 7.45V6.5"),
);
