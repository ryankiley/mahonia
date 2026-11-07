// Which icon a piece of gear wears, decided by its gear type alone.
//
// By TYPE, not by catalog row, so a hand-typed row gets one the moment it has a type
// ("hiking boots", "Stuff Sack", a type you made up that happens to say "jacket"),
// and two rows of the same kind always match.
//
// A SMALL set, on purpose (Ryan, 2026-11-07: "let's simplify the set"). An icon only
// works as a cue if it recurs: the first cut drew 60 different icons on a 139-piece
// page and 26 of them appeared once, which is a picture to decode rather than one to
// recognise. So this is one icon per family, split only where rows in the SAME folder
// need telling apart (a Clothing folder holds jackets, shirts, pants, underwear,
// socks, shoes, boots, hats, neckwear, gloves and glasses; a kitchen holds the stove,
// the pot, the cup, the utensils, the bottle and the filter) and where the family's
// icon would be the wrong picture for a member (a bucket hat on a neck gaiter, a pot
// on a spork). Everything else goes without: a compass, an umbrella, an ice axe. No
// icon is better than a one-off one.
//
// The answer is a NAME, not a drawing: the drawings are Hugeicons glyphs and a few of
// our own (app/utils/gearGlyphs.ts), and the server and the tests have no business
// importing either. app/utils/gearIcons.ts turns the name into the icon.
//
// Rules run in order and the first match wins, so a narrow rule sits above the broad
// one it would otherwise lose to: "bottle cap" before "cap", "stake bag" before
// "stake", "hip belt" before "belt", "breakfast bar" before "breakfast", "camera
// case" before "case". Words match whole (\b), and the type is lowercased and its
// spaces collapsed first, so the catalog's "Stuff sack" and a typed "stuff SACK" are
// one answer.

export const GEAR_GLYPHS = [
  // shelter and sleep
  "tent", "cord", "poles", "sleep", "sleepAid", "pad",
  // carrying
  "backpack", "bag", "container", "wallet",
  // clothing, split the way a Clothing folder needs it
  "jacket", "shirt", "pants", "underwear", "socks", "shoe", "boot", "hat", "neck",
  "glove", "glasses",
  // water and kitchen
  "bottle", "filter", "stove", "pot", "cup", "utensils", "meal", "food",
  // tools
  "knife", "repair",
  // electronics: the devices people recognise at a glance, and one catch-all for the
  // rest (power banks, cables, chargers, pumps)
  "light", "phone", "watch", "earbuds", "camera", "electronics",
  // body
  "firstAid", "toiletry", "towel", "toilet",
  // camp
  "chair", "carabiner", "games",
] as const;
export type GearGlyph = (typeof GEAR_GLYPHS)[number];

const RULES: readonly (readonly [RegExp, GearGlyph])[] = [
  // the names whose last word would send them to the wrong family
  [/\b(bottle cap|filter cap)\b/, "bottle"],
  [/\b(stake bag|pole bag)\b/, "bag"],
  [/\bpill bottle\b/, "firstAid"],
  [/\bfuel bottle\b/, "stove"],
  [/\b(dropper bottle|toiletry bottle|spray bottle|toothbrush case)\b/, "toiletry"],
  [/\b(phone case|phone holder|phone pocket)\b/, "phone"],
  [/\b(camera case|camera clip|lens adapter)\b/, "camera"],
  [/\b(hydration vest|running vest|hydration pack)\b/, "backpack"],
  [/\b(hip belt|hip belt pocket|shoulder straps?|shoulder pads|sternum strap|compression straps|straps|mesh sleeve)\b/, "backpack"],
  [/\bfleece pants\b/, "pants"],
  [/\bpee funnel\b/, "toilet"],
  [/\b(coffee filter|coffee straw)\b/, "cup"],
  [/\bbreakfast bar\b/, "food"],
  [/\bbear hang kit\b/, "cord"],
  [/\b(bear canister|bear can|bear can key)\b/, "container"],
  [/\bbug net\b/, "tent"],
  [/\b(neck gaiter|buff|bandana|balaclava|scarf|headband)\b/, "neck"],

  // shelter and sleep
  [/\b(tent|inner tent|vestibule|tarp|bivy|groundsheet|ground sheet|footprint|tent floor|tent poles?)\b/, "tent"],
  [/\b(stakes?|pegs?|snow anchors?|stake tool)\b/, "tent"],
  [/\b(guylines?|cord|paracord|cord reel|bungee cord|line tensioner|ridgeline|rigging kit|rope)\b/, "cord"],
  [/\b(trekking poles?|hiking staff|poles?|pole holder)\b/, "poles"],
  [/\b(pillow|pillowcase|pillow strap|earplugs|eye mask)\b/, "sleepAid"],
  [/\b(sleeping bag|sleeping bag liner|quilt|blanket|sheet|hammock)\b/, "sleep"],
  [/\b(sleeping pad|foam pad|sit pad|back pad|vestibule mat|pad)\b/, "pad"],

  // clothing
  [/\b(jacket|anorak|shell|rain suit|wind shirt|softshell|parka|coat|puffy|puffer|fleece|hoodie|hoody|hood|sweater|pullover|midlayer|vest|insulated top|poncho)\b/, "jacket"],
  [/\b(underwear|boxers?|briefs?)\b/, "underwear"],
  [/\b(pants|leggings|tights|joggers|chaps|trousers|base layer bottoms|shorts|skirt|belt)\b/, "pants"],
  [/\b(shirt|tee|t-shirt|tank top|top|base layer top|long sleeve|sun shirt|arm sleeves|sports bra|bra|dress)\b/, "shirt"],
  [/\b(socks?|sock liners|booties|insoles)\b/, "socks"],
  [/\b(hiking boots?|mountaineering boots?|boots?|gaiters?|microspikes|crampons|snowshoes|laces)\b/, "boot"],
  [/\b(trail runners?|running shoes?|shoes?|sandals?)\b/, "shoe"],
  [/\b(beanie|toque|hat|cap|brimmer|head net)\b/, "hat"],
  [/\b(gloves?|glove liners|mitts|mittens)\b/, "glove"],
  [/\b(sunglasses|glasses|goggles)\b/, "glasses"],

  // water, with the hydration parts that go with it
  [/\b(water filter|filter|water treatment|purifier|cleaning tablets|water hang kit)\b/, "filter"],
  [/\b(water bottle|bottle|flask|soft flask|reservoir|bladder|hose|straw|tube clip|tube insulator|cleaning coupling)\b/, "bottle"],

  // kitchen and food: the drinks and the eating before the pot, the snacks before the meals
  [/\b(stove|canister stand|pot stand|windscreen|stove base|fuel canister|gas canister|canister tool|fuel|lighter|matches|fire starter)\b/, "stove"],
  [/\b(cup|mug|mug lid|coffee maker|french press|instant coffee|coffee)\b/, "cup"],
  [/\b(spork|spoon|utensils?|fork|chopsticks|spatula|tongs)\b/, "utensils"],
  [/\b(pot|cookset|frying pan|pan|kettle|pot lid|pot cozy|pot lifter|food cozy|funnel|egg holder|lid knob|handle grips)\b/, "pot"],
  [/\b(bars?|waffle|chews|gummies|candy|fruit snack|snack mix|snacks?|trail mix|pretzels?|electrolyte mix|drink mix|nut butter|dog food)\b/, "food"],
  [/\b(meals?|dinner|breakfast|lunch|ramen|noodles|bowl|plate|grill plate)\b/, "meal"],

  // tools
  [/\b(knife|saw|multitool|sheath|scissors)\b/, "knife"],
  [/\b(repair kit|repair patches|patches|repair buckle|buckle|tape|duct tape|sewing kit|sewing awl|screwdriver|zipper pulls)\b/, "repair"],

  // electronics and light
  [/\b(headlamp|flashlight|torch|lantern)\b/, "light"],
  [/\b(smartwatch|gps watch|watch)\b/, "watch"],
  [/\b(phone|gps handheld|gps|satellite messenger|plb|inreach|e-reader|kindle)\b/, "phone"],
  [/\b(earbuds|airpods|earphones|headphones)\b/, "earbuds"],
  [/\bcamera\b/, "camera"],
  [/\b(power bank|battery|battery pack|wall charger|charger|solar|solar panel|charging cable|cable|air pump|inflator|pump)\b/, "electronics"],

  // body
  [/\b(first aid|blister care|moleskin|bandages?|tick remover|tweezers|antacid|pills?|medication)\b/, "firstAid"],
  [/\b(trowel|shovel|wipes?|face wipe|toilet paper|pee cloth|bidet|tissues?|waste tablets|bathroom kit)\b/, "toilet"],
  [/\btowels?\b/, "towel"],
  [/\b(toothbrush|toothpaste|sunscreen|spf|lip balm|lip guards|deodorant|balm|salve|lotion|cream|moisturi[sz]er|cleanser|soap|sanitizer|bite relief|insect repellent|hairbrush|brush|nail clippers)\b/, "toiletry"],

  // a jar, a container, a cooler: after the toiletries, so "cleanser + container" is a
  // toiletry and only a bare container is one
  [/\b(jar|container|cooler)\b/, "container"],

  // camp
  [/\b(camp chair|chair|camp stool|stool)\b/, "chair"],
  [/\b(carabiner|gear hooks?)\b/, "carabiner"],
  [/\b(card game|cards|games?|chess|dice|cribbage)\b/, "games"],

  // a bag or a case of anything not named above: after every rule that knows what
  // the case holds, so a camera case is a camera and a pack liner a bag
  [/\bwallet\b/, "wallet"],
  [/\b(stuff sack|compression sack|dry bag|pack liner|pouch|toiletry bag|packing cubes?|zip ?lock|food bag|odou?r[- ]proof bag|smell proof bag|freezer bag|waste bags?|bear bag|sack|case|bag)\b/, "bag"],
  [/\b(backpack|daypack|fastpack|duffel|fanny pack|hip pack|chest pack|sling bag|shoulder pocket|pack)\b/, "backpack"],
];

function glyphOf(text: string | null | undefined): GearGlyph | null {
  const words = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!words) return null;
  for (const [rule, glyph] of RULES) if (rule.test(words)) return glyph;
  return null;
}

/**
 * The icon a piece of gear wears, or null when none fits well enough to show.
 *
 * The gear TYPE decides. Only a row with no type at all falls back to its name, which
 * is how a hand-typed "Deodorant" or "Meals - Dinner" still gets one. A row whose type
 * matched nothing ("Ice axe") stays blank: the type is the row's own answer to "what
 * is this", and its name is often a model name that only sounds like a thing.
 */
export function gearGlyphFor(
  commonName: string | null | undefined,
  name?: string | null,
): GearGlyph | null {
  return (commonName ?? "").trim() ? glyphOf(commonName) : glyphOf(name);
}
