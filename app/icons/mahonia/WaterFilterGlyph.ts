import { glyph, line } from "./parts";

/** A funnel with a drop under it: anything that filters or treats water. The funnel is
 *  Central's filter funnel (IconFilter1) in proportion, its wide rounded top and the
 *  curve into the spout, shortened to leave room; the drop is Central's IconDrop scaled
 *  down, so it matches the water icons beside it. */
export const WaterFilterGlyph = glyph(
  line("M7.91 3H16.09A2.24 2.24 0 0 1 17.67 6.82L14.7 9.8C14.25 10.25 14 10.86 14 11.49V12.5H10V11.49C10 10.86 9.75 10.25 9.3 9.8L6.33 6.82A2.24 2.24 0 0 1 7.91 3Z"),
  line("M14.5 19.5C14.5 20.88 13.38 22 12 22C10.62 22 9.5 20.88 9.5 19.5C9.5 18.07 10.83 16.51 11.55 15.77C11.8 15.51 12.2 15.51 12.45 15.77C13.17 16.51 14.5 18.07 14.5 19.5Z"),
);
