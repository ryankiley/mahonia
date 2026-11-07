import {
  Backpack02Icon,
  BatteryCharging01Icon,
  ChocolateIcon,
  CookingPotIcon,
  Fire02Icon,
  FirstAidKitIcon,
  GlassesIcon,
  GloveIcon,
  HatIcon,
  JoggerPantsIcon,
  PocketKnifeIcon,
  Shirt01Icon,
  ShovelIcon,
  SneakerIcon,
  SocksIcon,
  TentIcon,
  YogaMatIcon,
} from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { gearGlyphFor, type GearGlyph } from "~~/shared/gearGlyph";
import {
  JacketGlyph,
  SleepingBagGlyph,
  StuffSackGlyph,
  TrekkingPolesGlyph,
  TubeGlyph,
  WaterBottleGlyph,
  WaterFilterGlyph,
} from "./gearGlyphs";

// The icon for each name shared/gearGlyph.ts can answer. A Record over the whole
// union, so a name added there without a drawing here is a type error, not a row that
// silently goes blank.
//
// Its own module, imported only by the surfaces that show gear icons, so the path data
// belongs to the pages that draw it and never to the editor's first load.
const GEAR_ICONS: Record<GearGlyph, IconNode> = {
  tent: TentIcon,
  poles: TrekkingPolesGlyph,
  sleep: SleepingBagGlyph,
  pad: YogaMatIcon,
  backpack: Backpack02Icon,
  bag: StuffSackGlyph,
  jacket: JacketGlyph,
  shirt: Shirt01Icon,
  pants: JoggerPantsIcon,
  socks: SocksIcon,
  shoe: SneakerIcon,
  hat: HatIcon,
  glove: GloveIcon,
  glasses: GlassesIcon,
  bottle: WaterBottleGlyph,
  filter: WaterFilterGlyph,
  stove: Fire02Icon,
  pot: CookingPotIcon,
  food: ChocolateIcon,
  knife: PocketKnifeIcon,
  electronics: BatteryCharging01Icon,
  firstAid: FirstAidKitIcon,
  toiletry: TubeGlyph,
  toilet: ShovelIcon,
};

/** The icon a piece of gear wears, from its gear type; null when nothing fits. */
export function gearIcon(commonName: string | null | undefined): IconNode | null {
  const glyph = gearGlyphFor(commonName);
  return glyph ? GEAR_ICONS[glyph] : null;
}
