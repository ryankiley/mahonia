import { glyph, line, ring } from "./parts";

/** Glasses: two round lenses, the bridge, the arms. */
export const GlassesGlyph = glyph(
  ring(6.5, 14.5, 3.5),
  ring(17.5, 14.5, 3.5),
  line("M10 14C11 13 13 13 14 14"),
  line("M3.15 13.2L5 7.5"),
  line("M20.85 13.2L19 7.5"),
);
