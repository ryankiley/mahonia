// Which picture a piece of gear wears, decided by its gear type alone.
//
// By TYPE, not by catalog row, so a hand-typed row gets one the moment it has a type
// ("hiking boots", "Stuff Sack", a type you made up that happens to say "jacket"),
// and two rows of the same kind always match. A photo would tell your Kakwa from
// your Aerios; this tells a pack from a quilt at a glance, which is the job on a page
// of a hundred rows that all used to look the same.
//
// The answer is a NAME, not a drawing: the drawings are Hugeicons glyphs and a few of
// our own (app/utils/gearGlyphs.ts), and the server and the tests have no business
// importing either. app/utils/gearIcons.ts turns the name into the picture.
//
// Rules run in order and the first match wins, so a narrow rule sits above the broad
// one it would otherwise lose to: "sleeping bag liner" before "sleeping bag", "down
// jacket" before "jacket", "neck gaiter" before "gaiter", "fuel canister" before
// "bear canister" stays unmatched. Words match whole (\b), and the type is lowercased
// and its spaces collapsed first, so the catalog's "Stuff sack" and a typed "stuff
// SACK" are one answer. No rule matches → null, and the row simply has no picture:
// a wrong one is worse than none.

export const GEAR_GLYPHS = [
  // shelter and sleep
  "tent", "tarp", "bivy", "groundsheet", "stake", "poles",
  "quilt", "sleepingBag", "pad", "pillow",
  // packs and bags
  "backpack", "hipPack", "stuffSack", "dryBag", "pouch", "zipBag", "wallet",
  // clothing
  "jacket", "puffy", "hoodie", "vest", "longSleeve", "tshirt", "pants", "shorts",
  "underwear", "socks", "runningShoes", "sneaker", "shoes", "sandals",
  "beanie", "sunHat", "cap", "neckGaiter", "glove", "sunglasses", "bug",
  // water
  "bottle", "softFlask", "reservoir", "filter",
  // kitchen and food
  "stove", "canister", "pot", "kettle", "cup", "spoon", "knife", "matches",
  "meal", "bar", "candy", "jar",
  // electronics and light
  "headlamp", "flashlight", "lantern", "powerBank", "solar", "cable", "phone",
  "watch", "gps", "camera", "earbuds", "headphones", "book",
  // body and camp
  "firstAid", "pills", "tooth", "tube", "stick", "towel", "wipes", "soap", "trowel",
  // the rest
  "chair", "carabiner", "cards", "compass", "map", "whistle", "umbrella",
  "binoculars", "scissors", "thermometer",
] as const;
export type GearGlyph = (typeof GEAR_GLYPHS)[number];

const RULES: readonly (readonly [RegExp, GearGlyph])[] = [
  // sleep: the narrow names before the broad ones
  [/\b(sleeping bag liner|sheet|pillowcase|emergency blanket)\b/, "quilt"],
  [/\bsleeping bag\b/, "sleepingBag"],
  [/\b(quilt|blanket|top quilt)\b/, "quilt"],
  [/\b(sleeping pad|foam pad|sit pad|back pad|vestibule mat|pad)\b/, "pad"],
  [/\bpillow\b/, "pillow"],

  // shelter
  [/\bbivy\b/, "bivy"],
  [/\btarp\b/, "tarp"],
  [/\b(groundsheet|ground sheet|footprint|tent floor)\b/, "groundsheet"],
  [/\b(stake bag|pole bag|stuff sack|compression sack|rock sack|sack)\b/, "stuffSack"],
  [/\b(stakes?|pegs?|snow anchors?)\b/, "stake"],
  [/\b(trekking poles?|hiking staff|tent poles?|poles?)\b/, "poles"],
  [/\b(tent|inner tent|vestibule)\b/, "tent"],

  // clothing: the insulated jackets before the shells, the neck before the leg
  [/\b(down|insulated|synthetic|puffy|puffer) (jacket|hoodie|hoody|vest|pants|top|skirt)\b|\b(puffy|puffer|insulated top|down pants)\b/, "puffy"],
  [/\b(jacket|anorak|shell|rain suit|wind shirt|softshell|parka|coat)\b/, "jacket"],
  [/\b(neck gaiter|buff|bandana|balaclava|scarf|headband)\b/, "neckGaiter"],
  [/\b(head net|bug net|insect repellent|mosquito net)\b/, "bug"],
  [/\bfleece pants\b/, "pants"],
  [/\b(fleece|hoodie|hoody|sweater|pullover|midlayer|sun hoodie)\b/, "hoodie"],
  [/\b(hydration vest|running vest|vest)\b/, "vest"],
  [/\b(base layer bottoms|pants|leggings|tights|half tights|joggers|chaps|trousers)\b/, "pants"],
  [/\b(shorts|skirt|rain skirt)\b/, "shorts"],
  [/\b(underwear|boxers?|briefs?|sports bra|bra)\b/, "underwear"],
  [/\b(base layer top|long sleeve|sun shirt|running shirt|arm sleeves)\b/, "longSleeve"],
  [/\b(shirt|tee|t-shirt|tank top|top|dress)\b/, "tshirt"],
  [/\b(socks?|sock liners|gaiters?|booties|down socks|insoles)\b/, "socks"],
  [/\bbeanie|toque\b/, "beanie"],
  [/\b(bottle cap|filter cap)\b/, "bottle"],
  [/\b(cap|trucker hat|rain cap|baseball cap)\b/, "cap"],
  [/\b(sun hat|bucket hat|brimmer|hat)\b/, "sunHat"],
  [/\b(gloves?|glove liners|mitts|mittens|rain mitts|sun gloves)\b/, "glove"],
  [/\b(sunglasses|glasses|goggles)\b/, "sunglasses"],
  [/\b(trail runners?|running shoes?)\b/, "runningShoes"],
  [/\b(hiking boots?|boots?)\b/, "shoes"],
  [/\b(hiking shoes?|camp shoes?|approach shoes?|shoes?)\b/, "sneaker"],
  [/\bsandals?\b/, "sandals"],

  // packs and bags
  [/\b(dry bag|pack liner|roll top)\b/, "dryBag"],
  [/\b(food bag|odou?r[- ]proof bag|smell proof bag|freezer bag|waste bags?|bear bag|zip ?lock|ziploc|used items bag)\b/, "zipBag"],
  [/\b(fanny pack|hip pack|hip belt pocket|chest pack|sling bag|shoulder pocket|bum bag)\b/, "hipPack"],
  [/\b(backpack|daypack|fastpack|hydration pack|duffel|pack)\b/, "backpack"],
  [/\bwallet\b/, "wallet"],

  // the bottles that aren't for water
  [/\bpill bottle\b/, "pills"],
  [/\b(dropper bottle|toiletry bottle|spray bottle)\b/, "tube"],

  // the bottles that aren't for water, before the water bottle takes them
  [/\bpill bottle\b/, "pills"],
  [/\b(dropper bottle|toiletry bottle|spray bottle)\b/, "tube"],

  // water
  [/\b(soft flask|flask)\b/, "softFlask"],
  [/\b(water reservoir|reservoir|bladder)\b/, "reservoir"],
  [/\b(coffee filter|coffee straw)\b/, "cup"],
  [/\b(water filter|filter|water treatment|purifier|cleaning tablets|water hang kit)\b/, "filter"],
  [/\b(water bottle|bottle|squeeze bottle|fuel bottle)\b/, "bottle"],

  // kitchen: the gas before the burner, the burner before the pot
  [/\bbear (canister|can)\b/, "jar"],
  [/\b(fuel canister|gas canister|canister)\b(?! stand)/, "canister"],
  [/\b(stove|stove system|windscreen|canister stand|pot stand|stove base)\b/, "stove"],
  [/\bkettle\b/, "kettle"],
  [/\b(pot|cookset|frying pan|pan|pot lid)\b/, "pot"],
  [/\b(cup|mug|coffee|instant coffee|french press|coffee maker)\b/, "cup"],
  [/\b(spork|spoon|utensils?|fork|chopsticks|spatula|tongs)\b/, "spoon"],
  [/\b(knife|saw|multitool|sheath)\b/, "knife"],
  [/\b(lighter|matches|fire starter)\b/, "matches"],
  [/\b(meals?|dinner|breakfast|lunch|ramen|noodles|bowl|plate)\b/, "meal"],
  [/\b(energy bar|protein bar|granola bar|candy bar|breakfast bar|bars?|waffle|energy waffle)\b/, "bar"],
  [/\b(energy chews|chews|gummies|candy|fruit snack|snack mix|snack|trail mix|pretzels?)\b/, "candy"],
  [/\b(electrolyte mix|drink mix|nut butter|jar|container)\b/, "jar"],

  // electronics and light
  [/\bheadlamp\b/, "headlamp"],
  [/\bflashlight|torch\b/, "flashlight"],
  [/\blantern\b/, "lantern"],
  [/\b(power bank|battery|battery pack|wall charger|charger)\b/, "powerBank"],
  [/\bsolar\b/, "solar"],
  [/\b(charging cable|cable|cord reel)\b/, "cable"],
  [/\b(smartwatch|gps watch|watch)\b/, "watch"],
  [/\b(gps handheld|gps|satellite messenger|plb|inreach|messenger)\b/, "gps"],
  [/\b(phone|phone case|phone holder|phone pocket)\b/, "phone"],
  [/\b(earbuds|airpods|earphones)\b/, "earbuds"],
  [/\bheadphones\b/, "headphones"],
  [/\b(camera|lens adapter|camera clip|camera case)\b/, "camera"],
  [/\b(e-reader|kindle|book|notebook|pen|pencil)\b/, "book"],

  // body and camp
  [/\b(first aid kit|first aid|blister care|moleskin|bandages?|tick remover|tweezers)\b/, "firstAid"],
  [/\b(antacid|pill bottle|pills?|medication|ibuprofen)\b/, "pills"],
  [/\b(toothbrush|toothpaste|toothpaste tube|toothpaste tablets|toothbrush case|mouth guard)\b/, "tooth"],
  [/\b(sunscreen stick|lip balm|deodorant|anti-chafe balm|skin salve|balm|salve|stick)\b/, "stick"],
  [/\b(sunscreen|lotion|cream|moisturi[sz]er|cleanser|toiletry bottle|dropper bottle|bite relief)\b/, "tube"],
  [/\btowel\b/, "towel"],
  [/\b(wipes|tissues?|toilet paper|pee cloth|face wipe)\b/, "wipes"],
  [/\b(hand sanitizer|sanitizer|soap|bidet)\b/, "soap"],
  [/\b(trowel|shovel)\b/, "trowel"],

  // a bag or a case of anything not named above: after every rule that knows what
  // the case holds, so a phone case is a phone and a toothbrush case a tooth
  [/\b(pouch|toiletry bag|packing cubes?|tote bag|saddle bag|inflation bag|case|bag)\b/, "pouch"],

  // the rest
  [/\b(camp chair|chair|camp stool|stool)\b/, "chair"],
  [/\b(carabiner|gear hooks?|clip)\b/, "carabiner"],
  [/\b(card game|cards)\b/, "cards"],
  [/\bcompass\b/, "compass"],
  [/\bmap\b/, "map"],
  [/\b(whistle|bear bell)\b/, "whistle"],
  [/\b(umbrella|poncho)\b/, "umbrella"],
  [/\b(binoculars|monocular)\b/, "binoculars"],
  [/\bscissors\b/, "scissors"],
  [/\bthermometer\b/, "thermometer"],
];

/** The glyph a gear type wears, or null when none fits well enough to show. */
export function gearGlyphFor(commonName: string | null | undefined): GearGlyph | null {
  const type = (commonName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!type) return null;
  for (const [rule, glyph] of RULES) if (rule.test(type)) return glyph;
  return null;
}
