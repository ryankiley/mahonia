import { glyph, line } from "./parts";

/** Save to the device: an arrow down into a tray. Drawn here rather than taken from Central
 *  because the app's pick of Central doesn't include one (adding a pick needs the licensed
 *  package; see app/utils/icon.ts). The art sits inside 4–20 like the glyphs around it. */
export const SaveGlyph = glyph(
  line("M12 4V14.5"),
  line("M7.5 10L12 14.5L16.5 10"),
  line("M4 15V18C4 19.1 4.9 20 6 20H18C19.1 20 20 19.1 20 18V15"),
);
