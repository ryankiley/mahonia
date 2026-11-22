import { glyph, line } from "./parts";

/** A folding knife, half open: a handle with a rivet at each end, and a wide blade swung
 *  up from the left end, steep enough to sit over the handle rather than past it. The
 *  blade is closed, its edge running down to the handle, the way Central closes an
 *  outline; an edge left stopping short read as a loose stroke. The layout of a pocket
 *  knife Ryan picked out on the Noun Project, drawn to these rules rather than traced.
 *  Central's only knife is the table knife in its fork-and-knife (the meal icon). */
export const PocketKnifeGlyph = glyph(
  line("M5.5 15H18.5C19.88 15 21 16.12 21 17.5C21 18.88 19.88 20 18.5 20H5.5C4.12 20 3 18.88 3 17.5C3 16.12 4.12 15 5.5 15Z"),
  line("M6 15L14.4 4.4C14.9 3.75 15.9 3.8 16.3 4.5C17.4 6.6 17.3 8.9 15.9 10.5L10.5 15"),
  line("M5.5 17.5H5.51"),
  line("M18.5 17.5H18.51"),
);
