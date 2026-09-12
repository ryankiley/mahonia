// The catalog's axis vocabulary: the typed attributes a row can carry, and what each gear
// type is sold by. Lives in shared/ rather than scripts/ because three things key on it and
// only one of them is build-time: the variant reader and the checks (scripts/), and later
// the products-with-axes search (#335) and the gear-type pages (#334), which run in
// server/ and cannot import scripts/. Nothing in app/ imports it today, so it costs the
// bundle nothing. Keep it data: no fs, no regex over rows, no imports.

/** Column order in the CSV cell and the canonical key order in research JSON. */
export const ATTRIBUTE_KEYS = [
  "fit",
  "size",
  "torso",
  "length",
  "width",
  "temp_f",
  "fill_power",
  "r_value",
  "persons",
  "volume_l",
  "capacity_mah",
  "fuel_g",
  "fuel",
] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export interface RowAttributes {
  /** "Men's" | "Women's" | "Unisex" | "Kids": the gendered version, never a size. */
  fit?: string;
  /** A letter ("M", "XL", "S/M", "M+"), a footwear size with its region ("US 9",
   *  "UK 8", "EU 42", "JP 3"), a size word the maker uses ("Regular", "Jumbo"), or the
   *  maker's own scale ("4", "3-4", "D", "32"). Sleep lengths go in `length`; a pack's
   *  letter is its `torso`. */
  size?: string;
  /** Pack torso: a letter, a range ("S/M"), a word ("Regular"), or inches ("17in"). */
  torso?: string;
  /** A length word ("Short", "Regular", "Long", "Tall", "Petite", "Small", "Large",
   *  "X-Large", or a letter where the maker's length scale is letters) or a measurement
   *  ("6ft", "6ft 6in", "72in", "120cm", "100-120cm", "1m"). */
  length?: string;
  /** "Slim" | "Standard" | "Regular" | "Wide" | "Extra Wide" or inches / cm. */
  width?: string;
  /** Temperature rating in whole degrees F. A Celsius-only rating is converted. */
  temp_f?: number;
  /** Down fill power (500 to 1000). */
  fill_power?: number;
  /** Sleeping-pad R-value (0.5 to 15, one decimal). */
  r_value?: number;
  /** Shelter capacity in people (1 to 8, halves allowed: a 1.5P tent). */
  persons?: number;
  /** Volume in litres, to the millilitre (500ml is 0.5, 525ml is 0.525). */
  volume_l?: number;
  /** Battery capacity in mAh. */
  capacity_mah?: number;
  /** A fuel canister's net fuel, grams (the stored weight IS the gas). */
  fuel_g?: number;
  /** Stove / canister fuel type. */
  fuel?: string;
}

/** How a gear type reads its variant and what it is sold by. Every flag is a question the
 *  variant reader or a check asks; a type absent from the table answers no to all of them. */
export interface GearTraits {
  /** Small / Regular / Long, and the maker's letters, are a LENGTH scale (a quilt's "XL"). */
  lengthScaled?: true;
  /** A bare letter, range or length word is the torso (Zpacks "M", Osprey "S/M", "Short"). */
  pack?: true;
  /** "16oz" is fluid ounces, not a net weight (a 2oz balm is a weight). */
  container?: true;
  /** A bare "6in" is the item's length (not a stool's height or a ball's diameter). */
  lengthIn?: true;
  /** A bare "25in" is the pad width it fits. */
  widthIn?: true;
  /** A size needs its region ("US 9", not "9"). */
  footwear?: true;
  /** A row without kcal is a to-do. */
  food?: true;
  /** The axes the research pass fills when the variant does not state them. */
  soldBy?: readonly AttributeKey[];
}

const SLEEP_LENGTH: GearTraits = { lengthScaled: true, soldBy: ["temp_f", "length"] };
const PACK: GearTraits = { pack: true, soldBy: ["volume_l"] };
const BY_VOLUME: GearTraits = { soldBy: ["volume_l"] };
const CONTAINER: GearTraits = { container: true };
const CONTAINER_BY_VOLUME: GearTraits = { container: true, soldBy: ["volume_l"] };
const LENGTH_IN: GearTraits = { lengthIn: true };
const FOOTWEAR: GearTraits = { footwear: true, soldBy: ["fit", "size"] };
const FOOD: GearTraits = { food: true };

/** Keyed by the canonical gear type (scripts/gearTypes.ts), lower-cased. A key that matches
 *  no catalog row fails tests/catalog-data.test.ts, so a renamed type cannot leave a dead
 *  entry behind that silently stops the reader or a check from firing. */
export const GEAR_TRAITS: Record<string, GearTraits> = {
  // sleep
  quilt: SLEEP_LENGTH,
  "sleeping bag": SLEEP_LENGTH,
  "sleeping pad": { lengthScaled: true, soldBy: ["r_value", "length"] },
  "sleeping bag liner": { lengthScaled: true },
  "foam pad": { lengthScaled: true },
  bivy: { lengthScaled: true },
  hammock: { lengthScaled: true },
  sheet: { widthIn: true },
  // shelter
  tent: { soldBy: ["persons"] },
  // packs and bags
  backpack: PACK,
  fastpack: PACK,
  daypack: PACK,
  "running vest": BY_VOLUME,
  "hip pack": BY_VOLUME,
  "fanny pack": BY_VOLUME,
  "dry bag": BY_VOLUME,
  "stuff sack": BY_VOLUME,
  "compression sack": BY_VOLUME,
  "food bag": BY_VOLUME,
  "bear bag": BY_VOLUME,
  "bear canister": BY_VOLUME,
  // water and cook
  "water bottle": CONTAINER_BY_VOLUME,
  "water reservoir": BY_VOLUME,
  "soft flask": CONTAINER_BY_VOLUME,
  flask: CONTAINER,
  "water filter": CONTAINER,
  "water treatment": CONTAINER,
  pot: CONTAINER_BY_VOLUME,
  cup: CONTAINER_BY_VOLUME,
  kettle: CONTAINER,
  jar: CONTAINER,
  "squeeze bottle": CONTAINER,
  "dropper bottle": CONTAINER,
  "spray bottle": CONTAINER,
  "toiletry bottle": CONTAINER,
  "insect repellent": CONTAINER,
  // power and fuel
  "power bank": { soldBy: ["capacity_mah"] },
  "fuel canister": { soldBy: ["fuel_g"] },
  stove: { soldBy: ["fuel"] },
  // footwear
  "trail runners": FOOTWEAR,
  "hiking shoes": FOOTWEAR,
  "hiking boots": FOOTWEAR,
  sandals: FOOTWEAR,
  "camp shoes": FOOTWEAR,
  insoles: { footwear: true, soldBy: ["size"] },
  booties: { footwear: true, soldBy: ["size"] },
  // things whose one dimension is a length
  "tent stakes": LENGTH_IN,
  straps: LENGTH_IN,
  "rubber bands": LENGTH_IN,
  straw: LENGTH_IN,
  "tent poles": LENGTH_IN,
  "shoulder straps": LENGTH_IN,
  snowshoes: LENGTH_IN,
  cord: LENGTH_IN,
  paracord: LENGTH_IN,
  guyline: LENGTH_IN,
  ridgeline: LENGTH_IN,
  "trekking poles": LENGTH_IN,
  "ice axe": LENGTH_IN,
  "charging cable": LENGTH_IN,
  // food
  meal: FOOD,
  "energy bar": FOOD,
  "protein bar": FOOD,
  "granola bar": FOOD,
  "candy bar": FOOD,
  "energy chews": FOOD,
  "energy waffle": FOOD,
  "nut butter": FOOD,
  snack: FOOD,
  "snack mix": FOOD,
  "fruit snack": FOOD,
  "electrolyte mix": FOOD,
  "instant coffee": FOOD,
};

// Garments are sold by size whatever the type is called, and the vocabulary has forty of
// them, so a suffix rule instead of forty entries. Word-anchored: a laptop is not a top.
const GARMENT = /\b(?:jacket|hoody|hoodie|fleece|pants|shorts|shirt|tee|top|bottoms|leggings|tights|vest|skirt|pullover|sweater|anorak|parka|coat|socks|underwear|bra)$/;
/** Trousers: Short / Regular / Long beside a size is the inseam. */
export const INSEAM_TYPE = /\b(?:pants|leggings|tights|bottoms)$/;

const NONE: GearTraits = {};

/** The traits of a gear type, by its canonical label in any case; `{}` for one not listed. */
export function traitsOf(commonName: string | null | undefined): GearTraits {
  return GEAR_TRAITS[(commonName ?? "").trim().toLowerCase()] ?? NONE;
}

/** The axes a gear type is sold by: its table entry, else `size` for a garment, else none. */
export function soldByOf(commonName: string | null | undefined): readonly AttributeKey[] {
  const type = (commonName ?? "").trim().toLowerCase();
  return GEAR_TRAITS[type]?.soldBy ?? (GARMENT.test(type) ? ["size"] : []);
}
