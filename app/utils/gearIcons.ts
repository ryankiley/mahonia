import {
  Backpack02Icon,
  Camera01Icon,
  Chair02Icon,
  ChessKnightIcon,
  ChocolateIcon,
  Coffee02Icon,
  CookingPotIcon,
  EnergyIcon,
  FirstAidKitIcon,
  GlassesIcon,
  GloveIcon,
  HatIcon,
  JarIcon,
  JoggerPantsIcon,
  LassoTool01Icon,
  MoneyBag01Icon,
  Music3Icon,
  PocketKnifeIcon,
  RiceBowl01Icon,
  Shirt01Icon,
  ShovelIcon,
  SmartPhone01Icon,
  SmartWatch01Icon,
  SneakerIcon,
  SocksIcon,
  SpoonIcon,
  TentIcon,
  TowelsIcon,
  UnderpantsIcon,
  Wallet01Icon,
  WaterEnergyIcon,
  Wrench01Icon,
  YogaMatIcon,
  ZzzIcon,
} from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { gearGlyphFor, type GearGlyph } from "~~/shared/gearGlyph";
import {
  CarabinerGlyph,
  HeadlampGlyph,
  HikingBootGlyph,
  JacketGlyph,
  NeckGaiterGlyph,
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
  cord: LassoTool01Icon,
  poles: TrekkingPolesGlyph,
  sleep: SleepingBagGlyph,
  sleepAid: ZzzIcon,
  pad: YogaMatIcon,
  backpack: Backpack02Icon,
  bag: MoneyBag01Icon,
  container: JarIcon,
  wallet: Wallet01Icon,
  jacket: JacketGlyph,
  shirt: Shirt01Icon,
  pants: JoggerPantsIcon,
  underwear: UnderpantsIcon,
  socks: SocksIcon,
  shoe: SneakerIcon,
  boot: HikingBootGlyph,
  hat: HatIcon,
  neck: NeckGaiterGlyph,
  glove: GloveIcon,
  glasses: GlassesIcon,
  bottle: WaterBottleGlyph,
  filter: WaterEnergyIcon,
  stove: StoveGlyph,
  pot: CookingPotIcon,
  cup: Coffee02Icon,
  utensils: SpoonIcon,
  meal: RiceBowl01Icon,
  food: ChocolateIcon,
  knife: PocketKnifeIcon,
  repair: Wrench01Icon,
  light: HeadlampGlyph,
  phone: SmartPhone01Icon,
  watch: SmartWatch01Icon,
  earbuds: Music3Icon,
  camera: Camera01Icon,
  electronics: EnergyIcon,
  firstAid: FirstAidKitIcon,
  toiletry: TubeGlyph,
  towel: TowelsIcon,
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
