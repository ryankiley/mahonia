import { glyph, line } from "./parts";

/** A folding knife, open: a short handle with its rivet, the blade swung out from the
 *  handle's end. Drawn half open, the blade lying back over a long handle, it read as a
 *  sled. Central's only knife is the table knife in its fork-and-knife, which is the
 *  meal icon, and alone it is too thin to read at 20px. */
export const PocketKnifeGlyph = glyph(
  line("M5 14H12C13.38 14 14.5 15.12 14.5 16.5C14.5 17.88 13.38 19 12 19H5C3.62 19 2.5 17.88 2.5 16.5C2.5 15.12 3.62 14 5 14Z"),
  line("M11 14L21.5 4.5C21.5 9 18.6 13.2 14.3 15.4"),
  line("M5.5 16.5H5.51"),
);
