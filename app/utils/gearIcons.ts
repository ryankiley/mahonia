import {
  Backpack02Icon,
  Bug02Icon,
  Camera01Icon,
  Chair02Icon,
  ChessKnightIcon,
  ChocolateIcon,
  Coffee02Icon,
  CookingPotIcon,
  DropletIcon,
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
  Underpants03Icon,
  Wallet01Icon,
  WaterEnergyIcon,
  Wrench01Icon,
  YogaMatIcon,
  ZzzIcon,
} from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import { GEAR_GLYPH_LABELS, GEAR_GLYPHS, gearGlyphFor, type GearGlyph } from "~~/shared/gearGlyph";
import {
  CarabinerGlyph,
  HeadlampGlyph,
  HikingBootGlyph,
  IceAxeGlyph,
  JacketGlyph,
  NeckGaiterGlyph,
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
  bug: Bug02Icon,
  cord: LassoTool01Icon,
  poles: TrekkingPolesGlyph,
  sleep: ZzzIcon,
  pad: YogaMatIcon,
  backpack: Backpack02Icon,
  bag: MoneyBag01Icon,
  container: JarIcon,
  wallet: Wallet01Icon,
  jacket: JacketGlyph,
  shirt: Shirt01Icon,
  pants: JoggerPantsIcon,
  underwear: Underpants03Icon,
  socks: SocksIcon,
  shoe: SneakerIcon,
  boot: HikingBootGlyph,
  hat: HatIcon,
  neck: NeckGaiterGlyph,
  glove: GloveIcon,
  glasses: GlassesIcon,
  bottle: WaterBottleGlyph,
  hydration: DropletIcon,
  filter: WaterEnergyIcon,
  stove: StoveGlyph,
  pot: CookingPotIcon,
  cup: Coffee02Icon,
  utensils: SpoonIcon,
  meal: RiceBowl01Icon,
  food: ChocolateIcon,
  knife: PocketKnifeIcon,
  repair: Wrench01Icon,
  iceAxe: IceAxeGlyph,
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
