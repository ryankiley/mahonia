import { IconAirpods, IconBackpack, IconBottle, IconBug, IconCamera1, IconCandy, IconCap, IconChair, IconCooking, IconCup, IconDice5, IconDrop, IconFashion, IconForkKnife, IconForkSpoon, IconHammer, IconHead, IconLightning, IconMedicalCrossSquare, IconMoneybag, IconPhone, IconSelectLasso, IconShovel, IconSleep, IconSmartwatch2, IconWallet1 } from "../icons/central";
import type { IconNode } from "./icon";
import { GEAR_GLYPH_LABELS, GEAR_GLYPHS, gearGlyphFor, type GearGlyph } from "~~/shared/gearGlyph";
import { CanisterGlyph, CarabinerGlyph, GlassesGlyph, GloveGlyph, HeadlampGlyph, HikingBootGlyph, IceAxeGlyph, JacketGlyph, PantsGlyph, PocketKnifeGlyph, ShoeGlyph, SleepingPadGlyph, SocksGlyph, StoveGlyph, TentGlyph, TowelGlyph, TrekkingPolesGlyph, TubeGlyph, UnderwearGlyph, WaterFilterGlyph } from "../icons/mahonia";

// The icon for each name shared/gearGlyph.ts can answer. A Record over the whole
// union, so a name added there without a drawing here is a type error, not a row that
// silently goes blank.
//
// Its own module, imported only by the surfaces that show gear icons, so the path data
// belongs to the pages that draw it and never to the editor's first load.
const GEAR_ICONS: Record<GearGlyph, IconNode> = {
  tent: TentGlyph,
  bug: IconBug,
  cord: IconSelectLasso,
  poles: TrekkingPolesGlyph,
  sleep: IconSleep,
  pad: SleepingPadGlyph,
  backpack: IconBackpack,
  bag: IconMoneybag,
  container: CanisterGlyph,
  wallet: IconWallet1,
  jacket: JacketGlyph,
  shirt: IconFashion,
  pants: PantsGlyph,
  underwear: UnderwearGlyph,
  socks: SocksGlyph,
  shoe: ShoeGlyph,
  boot: HikingBootGlyph,
  hat: IconCap,
  neck: IconHead,
  glove: GloveGlyph,
  glasses: GlassesGlyph,
  bottle: IconBottle,
  hydration: IconDrop,
  filter: WaterFilterGlyph,
  stove: StoveGlyph,
  pot: IconCooking,
  cup: IconCup,
  utensils: IconForkSpoon,
  meal: IconForkKnife,
  food: IconCandy,
  knife: PocketKnifeGlyph,
  repair: IconHammer,
  iceAxe: IceAxeGlyph,
  light: HeadlampGlyph,
  phone: IconPhone,
  watch: IconSmartwatch2,
  earbuds: IconAirpods,
  camera: IconCamera1,
  electronics: IconLightning,
  firstAid: IconMedicalCrossSquare,
  toiletry: TubeGlyph,
  towel: TowelGlyph,
  toilet: IconShovel,
  chair: IconChair,
  carabiner: CarabinerGlyph,
  games: IconDice5,
};

/** The icon a piece of gear wears: the one you picked for it, else its gear type's
 *  (its name's when it has none); null when nothing fits. */
export function gearIcon(
  commonName: string | null | undefined,
  name?: string | null,
  picked?: GearGlyph | null,
): IconNode | null {
  const glyph = picked ?? gearGlyphFor(commonName, name);
  return glyph ? GEAR_ICONS[glyph] : null;
}

/** The name the icon goes by, for whichever icon gearIcon would draw. */
export function gearIconLabel(
  commonName: string | null | undefined,
  name?: string | null,
  picked?: GearGlyph | null,
): string | null {
  const glyph = picked ?? gearGlyphFor(commonName, name);
  return glyph ? GEAR_GLYPH_LABELS[glyph] : null;
}

/** Every icon in the set, in the set's own order (shelter, carrying, clothing, water
 *  and kitchen, tools, electronics, body, camp), for picking one by hand. */
export const GEAR_ICON_CHOICES = GEAR_GLYPHS.map((glyph) => ({
  glyph,
  icon: GEAR_ICONS[glyph],
  label: GEAR_GLYPH_LABELS[glyph],
}));
