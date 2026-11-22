import { glyph, line } from "./parts";

/** An A-frame tent: the fly in one stroke with its ridge rounded, standing on the ground
 *  line, and a door. Open at the foot rather than a closed triangle, which reads as a
 *  warning sign without its "!". */
export const TentGlyph = glyph(
  line("M3.5 19.5L10.68 6.4C11.25 5.36 12.75 5.36 13.32 6.4L20.5 19.5"),
  line("M2 19.5H22"),
  line("M9 19.5L11.09 14.97C11.45 14.19 12.55 14.19 12.91 14.97L15 19.5"),
);
