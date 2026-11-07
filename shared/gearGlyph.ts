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
// need telling apart — a Clothing folder holds jackets, shirts, pants, socks, shoes,
// hats, gloves and glasses; a kitchen holds the stove, the pot, the bottle and the
// filter. Everything else goes without: a chair, a deck of cards, a compass, a
// carabiner. No icon is better than a one-off one.
//
// The answer is a NAME, not a drawing: the drawings are Hugeicons glyphs and a few of
// our own (app/utils/gearGlyphs.ts), and the server and the tests have no business
// importing either. app/utils/gearIcons.ts turns the name into the icon.
//
// Rules run in order and the first match wins, so a narrow rule sits above the broad
// one it would otherwise lose to: "bottle cap" before "cap", "stake bag" before
// "stake", "neck gaiter" before "gaiters", "running vest" before "vest", "camera
// case" before "case". Words match whole (\b), and the type is lowercased and its
// spaces collapsed first, so the catalog's "Stuff sack" and a typed "stuff SACK" are
// one answer.

export const GEAR_GLYPHS = [
  // shelter and sleep
  "tent", "poles", "sleep", "pad",
  // carrying
  "backpack", "bag",
  // clothing, split the way a Clothing folder needs it
  "jacket", "shirt", "pants", "socks", "shoe", "hat", "glove", "glasses",
  // water and kitchen
  "bottle", "filter", "stove", "pot", "food", "knife",
  // anything with a battery or a cable: one catch-all icon, since each kind is a
  // one-off on a page
  "electronics",
  // body
  "firstAid", "toiletry", "toilet",
] as const;
export type GearGlyph = (typeof GEAR_GLYPHS)[number];

const RULES: readonly (readonly [RegExp, GearGlyph])[] = [
  // the names whose last word would send them to the wrong family
  [/\b(bottle cap|filter cap)\b/, "bottle"],
  [/\b(stake bag|pole bag)\b/, "bag"],
  [/\bpill bottle\b/, "firstAid"],
  [/\b(dropper bottle|toiletry bottle|spray bottle|toothbrush case)\b/, "toiletry"],
  [/\b(phone case|phone holder|phone pocket|camera case|camera clip|lens adapter)\b/, "electronics"],
  [/\b(hydration vest|running vest|hydration pack)\b/, "backpack"],
  [/\bfleece pants\b/, "pants"],
  [/\b(neck gaiter|buff|bandana|balaclava|scarf|headband|head net|bug net)\b/, "hat"],

  // shelter and sleep
  [/\b(tent|inner tent|vestibule|tarp|bivy|groundsheet|ground sheet|footprint|tent floor)\b/, "tent"],
  [/\b(stakes?|pegs?|snow anchors?|stake tool)\b/, "tent"],
  [/\b(trekking poles?|hiking staff|tent poles?|poles?)\b/, "poles"],
  [/\b(sleeping bag|sleeping bag liner|quilt|blanket|sheet|pillow|pillowcase|hammock)\b/, "sleep"],
  [/\b(sleeping pad|foam pad|sit pad|back pad|vestibule mat|pad)\b/, "pad"],

  // clothing
  [/\b(jacket|anorak|shell|rain suit|wind shirt|softshell|parka|coat|puffy|puffer|fleece|hoodie|hoody|sweater|pullover|midlayer|vest|insulated top|poncho)\b/, "jacket"],
  [/\b(pants|leggings|tights|joggers|chaps|trousers|base layer bottoms|shorts|skirt|underwear|boxers?|briefs?)\b/, "pants"],
  [/\b(shirt|tee|t-shirt|tank top|top|base layer top|long sleeve|sun shirt|arm sleeves|sports bra|bra|dress)\b/, "shirt"],
  [/\b(socks?|sock liners|gaiters?|booties|insoles)\b/, "socks"],
  [/\b(trail runners?|running shoes?|shoes?|boots?|sandals?)\b/, "shoe"],
  [/\b(beanie|toque|hat|cap|brimmer)\b/, "hat"],
  [/\b(gloves?|glove liners|mitts|mittens)\b/, "glove"],
  [/\b(sunglasses|glasses|goggles)\b/, "glasses"],

  // water
  [/\b(coffee filter)\b/, "pot"],
  [/\b(water filter|filter|water treatment|purifier|cleaning tablets|water hang kit)\b/, "filter"],
  [/\b(water bottle|bottle|flask|soft flask|reservoir|bladder)\b/, "bottle"],

  // kitchen and food
  [/\b(stove|canister stand|pot stand|windscreen|stove base|fuel canister|gas canister|fuel|lighter|matches|fire starter)\b/, "stove"],
  [/\b(pot|cookset|frying pan|pan|kettle|cup|mug|coffee maker|french press|spork|spoon|utensils?|fork|chopsticks|spatula|tongs|bowl|plate)\b/, "pot"],
  [/\b(meals?|dinner|breakfast|lunch|bars?|waffle|chews|gummies|candy|fruit snack|snack mix|snacks?|trail mix|pretzels?|electrolyte mix|drink mix|nut butter|instant coffee|coffee)\b/, "food"],
  [/\b(knife|saw|multitool|sheath|scissors)\b/, "knife"],

  // electronics and light
  [/\b(headlamp|flashlight|torch|lantern|smartwatch|gps watch|watch|phone|gps handheld|gps|satellite messenger|plb|inreach|e-reader|kindle|power bank|battery|battery pack|wall charger|charger|solar|solar panel|charging cable|cable|earbuds|airpods|earphones|headphones|camera)\b/, "electronics"],

  // body
  [/\b(first aid|blister care|moleskin|bandages?|tick remover|tweezers|antacid|pills?|medication)\b/, "firstAid"],
  [/\b(trowel|shovel|wipes?|face wipe|toilet paper|pee cloth|bidet|tissues?)\b/, "toilet"],
  [/\b(toothbrush|toothpaste|sunscreen|lip balm|deodorant|balm|salve|lotion|cream|moisturi[sz]er|cleanser|soap|sanitizer|towel|bite relief|insect repellent)\b/, "toiletry"],

  // a bag or a case of anything not named above: after every rule that knows what
  // the case holds, so a camera case is a camera and a pack liner a bag
  [/\b(stuff sack|compression sack|dry bag|pack liner|pouch|toiletry bag|packing cubes?|wallet|zip ?lock|food bag|odou?r[- ]proof bag|smell proof bag|freezer bag|waste bags?|bear bag|sack|case|bag)\b/, "bag"],
  [/\b(backpack|daypack|fastpack|duffel|fanny pack|hip pack|hip belt pocket|chest pack|sling bag|shoulder pocket|pack)\b/, "backpack"],
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
 * matched nothing ("Camp chair") stays blank: the type is the row's own answer to
 * "what is this", and its name is often a model name that only sounds like a thing.
 */
export function gearGlyphFor(
  commonName: string | null | undefined,
  name?: string | null,
): GearGlyph | null {
  return (commonName ?? "").trim() ? glyphOf(commonName) : glyphOf(name);
}
