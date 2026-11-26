import { glyph, line } from "./parts";

/** A towel on a rail, a band across it and its fringe. */
export const TowelGlyph = glyph(
  line("M3 4H21"),
  line("M6 4V17.5C6 18.05 6.45 18.5 7 18.5H17C17.55 18.5 18 18.05 18 17.5V4"),
  line("M6 14H18"),
  line("M8.5 18.5V21"),
  line("M12 18.5V21"),
  line("M15.5 18.5V21"),
);
