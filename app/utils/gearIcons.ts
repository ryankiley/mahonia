import {
  Airpod03Icon,
  Backpack02Icon,
  Camera01Icon,
  Chair02Icon,
  ChessKnightIcon,
  ChocolateIcon,
  CookingPotIcon,
  EnergyIcon,
  FirstAidKitIcon,
  GlassesIcon,
  GloveIcon,
  HatIcon,
  JoggerPantsIcon,
  MoneyBag01Icon,
  PocketKnifeIcon,
  Shirt01Icon,
  ShovelIcon,
  SmartPhone01Icon,
  SmartWatch01Icon,
  SneakerIcon,
  SocksIcon,
  TentIcon,
  WaterEnergyIcon,
  YogaMatIcon,
} from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { gearGlyphFor, type GearGlyph } from "~~/shared/gearGlyph";
import {
  CarabinerGlyph,
  HeadlampGlyph,
  HikingBootGlyph,
  JacketGlyph,
  SleepingBagGlyph,
  StoveGlyph,
  TrekkingPolesGlyph,
  TubeGlyph,
  WaterBottleGlyph,
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
  bag: MoneyBag01Icon,
  jacket: JacketGlyph,
  shirt: Shirt01Icon,
  pants: JoggerPantsIcon,
  socks: SocksIcon,
  shoe: SneakerIcon,
  boot: HikingBootGlyph,
  hat: HatIcon,
  glove: GloveIcon,
  glasses: GlassesIcon,
  bottle: WaterBottleGlyph,
  filter: WaterEnergyIcon,
  stove: StoveGlyph,
  pot: CookingPotIcon,
  food: ChocolateIcon,
  knife: PocketKnifeIcon,
  light: HeadlampGlyph,
  phone: SmartPhone01Icon,
  watch: SmartWatch01Icon,
  earbuds: Airpod03Icon,
  camera: Camera01Icon,
  electronics: EnergyIcon,
  firstAid: FirstAidKitIcon,
  toiletry: TubeGlyph,
  toilet: ShovelIcon,
  chair: Chair02Icon,
  carabiner: CarabinerGlyph,
  games: ChessKnightIcon,
};

/** The icon a piece of gear wears, from its gear type (its name when it has none);
 *  null when nothing fits. */
export function gearIcon(commonName: string | null | undefined, name?: string | null): IconNode | null {
  const glyph = gearGlyphFor(commonName, name);
  return glyph ? GEAR_ICONS[glyph] : null;
}
