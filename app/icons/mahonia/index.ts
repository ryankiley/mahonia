// Mahonia's own glyphs: gear Central (../central) has no picture for,
// drawn in its round, radius-3 grammar so the two read as one family. A 24-unit grid
// with the art inside 2–22, outline strokes only, round caps and joins, large corners
// at radius 3 and small ones at 1–2, and no two strokes closer than about four units
// centre to centre: the app draws icons with a flat 1.5px line (1.25px at 14,
// utils/icon.ts), and anything tighter fills in. Each glyph is the same data shape as a
// Central glyph, so <SvgIcon :icon> draws it unchanged; like those, it carries
// no stroke width of its own and takes the one on the <svg>.
//
// The older glyphs here (poles, jacket, tube, stove, headlamp, carabiner, boot, gaiter,
// ice axe) were drawn and tuned in review, several from Ryan's sketches. When the app
// moved off Hugeicons they kept their ideas and were redrawn to these rules, all but the
// carabiner, which already followed them. The rest were drawn for that move, for gear
// Central has no picture for. app/utils/gearIcons.ts joins name to icon.
//
// One module per glyph, like ../central, so each lands only in the chunks that draw it;
// the pieces they're built from are in ./parts.ts.
export { TrekkingPolesGlyph } from "./TrekkingPolesGlyph";
export { JacketGlyph } from "./JacketGlyph";
export { TubeGlyph } from "./TubeGlyph";
export { StoveGlyph } from "./StoveGlyph";
export { HeadlampGlyph } from "./HeadlampGlyph";
export { CarabinerGlyph } from "./CarabinerGlyph";
export { HikingBootGlyph } from "./HikingBootGlyph";
export { NeckGaiterGlyph } from "./NeckGaiterGlyph";
export { IceAxeGlyph } from "./IceAxeGlyph";
export { TentGlyph } from "./TentGlyph";
export { SleepingPadGlyph } from "./SleepingPadGlyph";
export { PantsGlyph } from "./PantsGlyph";
export { UnderwearGlyph } from "./UnderwearGlyph";
export { SocksGlyph } from "./SocksGlyph";
export { ShoeGlyph } from "./ShoeGlyph";
export { GloveGlyph } from "./GloveGlyph";
export { GlassesGlyph } from "./GlassesGlyph";
export { WaterFilterGlyph } from "./WaterFilterGlyph";
export { PocketKnifeGlyph } from "./PocketKnifeGlyph";
export { TowelGlyph } from "./TowelGlyph";
export { MountainGlyph } from "./MountainGlyph";
export { StairsGlyph } from "./StairsGlyph";
export { FuelCanGlyph } from "./FuelCanGlyph";
export { CanisterGlyph } from "./CanisterGlyph";
