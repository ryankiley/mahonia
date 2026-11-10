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
// on a spork). Everything else goes without: a compass, an umbrella, a whistle. No
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

/**
 * The FAMILIES the icons fall into, in the set's own order: how My Gear groups
 * your gear now that it has no folders (Ryan: "I'm not even sure the folders make a lot
 * of sense"). A folder said where a piece was filed, copied from a list's section
 * name; a family says what kind of thing it is, read off its gear type the way its
 * icon is, so nothing has to be filed and nothing drifts. What goes together is a
 * KIT's job. A piece whose type matches no icon has no family, and sits under Other.
 *
 * Fine enough to find a thing by: the first cut lumped shoes into Clothing and the
 * water filter into one long "Food, water & kitchen", and Ryan read the kinds as too
 * coarse ("seeing footwear with clothing"), and a pack is not a stuff sack ("i don't
 * like packs and storage as one"). The sections a hiker's own list tends to have,
 * checked against another gear app's 21 and Ryan's own 150 pieces: first aid apart from the
 * hygiene that was 26 of its 30, poles out of Shelter, and Tools (empty) with Camp.
 *
 * Nothing stores a family: it's read off the icon on every render, so changing this
 * list regroups everyone's gear at once and needs no migration. It is also the list
 * of icons itself (GEAR_GLYPHS below is read off it), in the icon picker's order.
 */
export const GEAR_FAMILIES = [
  { key: "shelter", label: "Shelter", glyphs: ["tent", "bug", "cord"] },
  { key: "sleep", label: "Sleep", glyphs: ["sleep", "pad"] },
  { key: "packs", label: "Packs", glyphs: ["backpack"] },
  { key: "storage", label: "Storage", glyphs: ["bag", "container", "wallet"] },
  // clothing, split the way a Clothing folder needs it
  { key: "clothing", label: "Clothing", glyphs: ["jacket", "shirt", "pants", "underwear", "socks", "hat", "neck", "glove", "glasses"] },
  { key: "footwear", label: "Footwear", glyphs: ["shoe", "boot"] },
  { key: "water", label: "Water", glyphs: ["bottle", "hydration", "filter"] },
  { key: "kitchen", label: "Kitchen", glyphs: ["stove", "pot", "cup", "utensils"] },
  { key: "food", label: "Food", glyphs: ["meal", "food"] },
  // the devices people recognise at a glance, and one catch-all for the rest (power
  // banks, cables, chargers, pumps)
  { key: "electronics", label: "Electronics", glyphs: ["light", "phone", "watch", "earbuds", "camera", "electronics"] },
  { key: "firstaid", label: "First aid", glyphs: ["firstAid"] },
  { key: "hygiene", label: "Hygiene", glyphs: ["toiletry", "towel", "toilet"] },
  { key: "trekking", label: "Trekking", glyphs: ["poles", "iceAxe"] },
  { key: "camp", label: "Camp & tools", glyphs: ["chair", "games", "carabiner", "knife", "repair"] },
] as const;
export type GearFamily = (typeof GEAR_FAMILIES)[number]["key"];
export type GearGlyph = (typeof GEAR_FAMILIES)[number]["glyphs"][number];
/** Every icon in the set, family by family: the families' own list, flattened. */
export const GEAR_GLYPHS: readonly GearGlyph[] = GEAR_FAMILIES.flatMap((f) => f.glyphs);

const GLYPH_SET: ReadonlySet<string> = new Set(GEAR_GLYPHS);
/** A name off the wire or out of a column that still names an icon in the set. A
 *  stored pick whose icon has since been dropped from the set fails this and the row
 *  falls back to its type's icon, rather than drawing nothing. */
export function isGearGlyph(v: unknown): v is GearGlyph {
  return typeof v === "string" && GLYPH_SET.has(v);
}

const FAMILY_OF: ReadonlyMap<GearGlyph, GearFamily> = new Map(
  GEAR_FAMILIES.flatMap((f) => f.glyphs.map((g) => [g, f.key] as const)),
);
/** What a family is called on the page; null (no icon fits) is Other. */
export function gearFamilyLabel(family: GearFamily | null): string {
  return GEAR_FAMILIES.find((f) => f.key === family)?.label ?? "Other";
}

/** The family an icon belongs to, or null for no icon. */
export function gearFamilyOf(glyph: GearGlyph | null | undefined): GearFamily | null {
  return glyph ? (FAMILY_OF.get(glyph) ?? null) : null;
}

/** What each icon is called where you pick one by hand (the edit dialog's grid): its
 *  tooltip and its accessible name. Plain words for the family, not the drawing. */
export const GEAR_GLYPH_LABELS: Record<GearGlyph, string> = {
  tent: "Tent", bug: "Bug net", cord: "Cord", poles: "Trekking poles", sleep: "Sleep",
  pad: "Pad", backpack: "Backpack", bag: "Bag", container: "Container", wallet: "Wallet",
  jacket: "Jacket", shirt: "Shirt", pants: "Pants", underwear: "Underwear", socks: "Socks",
  shoe: "Shoes", boot: "Boots", hat: "Hat", neck: "Neckwear", glove: "Gloves",
  glasses: "Glasses", bottle: "Bottle", hydration: "Water", filter: "Filter",
  stove: "Stove", pot: "Pot", cup: "Cup", utensils: "Utensils", meal: "Meal",
  food: "Snack", knife: "Knife", repair: "Repair", iceAxe: "Ice axe", light: "Light", phone: "Phone",
  watch: "Watch", earbuds: "Audio", camera: "Camera", electronics: "Electronics",
  firstAid: "First aid", toiletry: "Toiletry", towel: "Towel", toilet: "Toilet",
  chair: "Chair", carabiner: "Carabiner", games: "Games",
};

const RULES: readonly (readonly [RegExp, GearGlyph])[] = [
  // the names whose last word would send them to the wrong family
  [/\b(bottle cap|filter cap)\b/, "bottle"],
  [/\b(stake bag|pole bag|rope bag|snack (pouch|sack|bag)s?)\b/, "bag"],
  // a food word in front of what holds or cleans it: since food reads on a tab of its
  // own (vaultTabOf), a misread here moves the piece off Gear, not just its icon
  [/\b(coffee|tea) (mugs?|cups?|grinder|dripper|infuser|strainer)\b/, "cup"],
  [/\b(bar soap|shower gel|hair gel|sanitizer gel)\b/, "toiletry"],
  [/\btea towels?\b/, "towel"],
  [/\bpill bottle\b/, "firstAid"],
  [/\bfuel bottle\b/, "stove"],
  [/\b(dropper bottle|toiletry bottle|spray bottle|toothbrush case|face wipes?)\b/, "toiletry"],
  [/\b(phone case|phone holder|phone pocket)\b/, "phone"],
  [/\b(camera case|camera clip|lens adapter)\b/, "camera"],
  [/\b(hydration vest|running vest|race vest|hydration pack|running belt|sling bag|crossbody bag|hip bag|waist bag|belt bag|bum bag|duffel bag)\b/, "backpack"],
  // a compression cap is a stuff-sack lid for a quilt, not a pack part
  [/\b(compression straps?|compression cap)\b/, "bag"],
  [/\b(hip belt|hip belt pocket|shoulder straps?|shoulder pads|back pad|lumbar pad|sternum strap|mesh sleeve|ventilation frame)\b/, "backpack"],
  [/\b(fleece pants|knee pads?)\b/, "pants"],
  [/\bpee funnel\b/, "toilet"],
  // the gear you make a drink WITH is the kitchen; the drink itself (below) is food
  [/\b(coffee filter|coffee straw|coffee maker|french press|coffee press|pour over|tea kettle)\b/, "cup"],
  // Ryan's leans on the audit's judgment calls (2026-11-08): what you drink is food, as
  // his own lists file it; a sit pad goes beside the chair; traction goes with the ice
  // axe; a hammock is a shelter; a toiletry bag goes with what it holds
  [/\b(electrolytes?|electrolyte mix|drink mix|hydration mix|sports drink|instant coffee|coffee|tea|cocoa|hot chocolate)\b/, "food"],
  [/\b(sit pads?|seat pads?|z seat)\b/, "chair"],
  [/\b(microspikes|crampons|snowshoes?|snow shoes?|traction devices?|ice cleats|yaktrax)\b/, "iceAxe"],
  [/\b(hammocks?|hammock straps|hammock suspension)\b/, "tent"],
  [/\b(toiletry bags?|toiletry case|toiletry kit|wash bag|dopp kit)\b/, "toiletry"],
  [/\bbreakfast bar\b/, "food"],
  [/\b(bear canister|bear can|bear can key|bear hang kit)\b/, "container"],
  // a HEAD net is worn, so it's neckwear below (and Clothing), not a shelter's bug net
  [/\b(bug net|bug shelter|mosquito net)\b/, "bug"],
  [/\b(first aid|emergency blanket|space blanket)\b/, "firstAid"],
  [/\b(neck gaiter|buff|bandana|balaclava|scarf|headband|head ?net)\b/, "neck"],
  // words a later rule would claim for the wrong family (the 2026-11-08 audit): a cord
  // that charges, a light that hangs in a tent, a pad that dresses a blister, a sheet
  // that goes under a tent, a shovel for snow, a bottle you pee in, a bag that holds
  // water, a pole that holds up a shelter, a cap on a lens or a bottle
  [/\b(charging cords?|usb cords?|power cords?|charger cords?)\b/, "electronics"],
  [/\b(tent lights?|tent lanterns?|camp lights?|string lights?)\b/, "light"],
  [/\b(pump sack|pad pump)\b/, "pad"],
  [/\b(blister pads?|gauze|alcohol pads?|alcohol wipes?|moleskin pads?|med(ical)? kit|meds|medicine|ibuprofen)\b/, "firstAid"],
  [/\b(tyvek|polycryo|rain ?fly|tent fly|shelter poles?|pole extenders?|pole jack)\b/, "tent"],
  [/\b(avalanche shovel|snow shovel|snow saw|avalanche probe)\b/, "iceAxe"],
  [/\b(pee bottle|wag bags?)\b/, "toilet"],
  [/\b((dirty )?water bags?|squeeze bags?|water container|water jug|water bladder)\b/, "hydration"],
  [/\b(sport cap|flip cap|bite valve)\b/, "bottle"],
  [/\blens cap\b/, "camera"],
  [/\b(pack cover|rain cover)\b/, "backpack"],

  // shelter and sleep
  [/\b(tent|inner tent|vestibule|tarp|bivy|groundsheet|ground sheet|footprint|tent floor|tent poles?)\b/, "tent"],
  [/\b(stakes?|pegs?|snow anchors?|stake tool)\b/, "tent"],
  [/\b(guy ?lines?|cord|paracord|cord reel|bungee cord|line tensioner|ridgeline|rigging kit|rope)\b/, "cord"],
  [/\b(trekking poles?|hiking staff|poles?|pole holder)\b/, "poles"],
  // what you sleep in and what helps you sleep: one Zzz, bag and pillow alike
  [/\b(sleeping bag|sleeping bag liner|quilt|blanket|sheet|pillow|pillowcase|pillow strap|earplugs|eye mask|mouth guard|night guard|underquilt)\b/, "sleep"],
  // (a sit pad is a chair, and a vestibule mat a tent, by the rules above)
  [/\b(sleeping pad|foam pad|pad)\b/, "pad"],

  // clothing
  [/\b(jacket|anorak|shell|rain suit|raincoat|windbreaker|wind shirt|softshell|parka|coat|puffy|puffer|fleece|hoodie|hoody|hood|sweater|pullover|midlayer|vest|insulated top|poncho)\b/, "jacket"],
  [/\b(underwear|boxers?|briefs?)\b/, "underwear"],
  [/\b(pants|leggings|tights|joggers|chaps|trousers|base layer bottoms|shorts|skirt|belt)\b/, "pants"],
  [/\b(shirt|tee|t-shirt|tank top|top|base layer top|base ?layer|mid ?layer|long sleeve|sun shirt|arm sleeves|sports bra|bra|dress)\b/, "shirt"],
  [/\b(socks?|sock liners|booties)\b/, "socks"],
  [/\b(hiking boots?|mountaineering boots?|boots?|gaiters?|laces)\b/, "boot"],
  [/\b(trail runners?|running shoes?|shoes?|sandals?|insoles?)\b/, "shoe"],
  [/\b(beanie|toque|hat|cap|brimmer)\b/, "hat"],
  [/\b(gloves?|glove liners|mitts|mittens)\b/, "glove"],
  [/\b(sunglasses|glasses|goggles)\b/, "glasses"],

  // water: the filter; then a droplet for the reservoir and the parts that hang off it;
  // then the bottle (what you mix into it is food, above)
  [/\b(water filter|filter|water treatment|purifier|cleaning tablets|purification tablets|aquatabs|water hang kit)\b/, "filter"],
  [/\b(water reservoir|reservoir|bladder|hose|tube clip|tube insulator|cleaning coupling)\b/, "hydration"],
  [/\b(water bottle|bottle|flask|soft flask|straw)\b/, "bottle"],

  // kitchen and food: the drinks and the eating before the pot, the snacks before the meals
  [/\b(stove|canister stand|pot stand|windscreen|stove base|fuel canister|gas canister|canister tool|fuel|lighter|matches|fire starter)\b/, "stove"],
  [/\b(cup|mug|mug lid|lip guards)\b/, "cup"],
  [/\b(spork|spoon|utensils?|fork|chopsticks|spatula|tongs)\b/, "utensils"],
  [/\b(pot|cookset|frying pan|pan|kettle|pot lid|pot cozy|pot lifter|food cozy|funnel|egg holder|lid knob|handle grips|bowl|plate)\b/, "pot"],
  [/\b(bars?|waffle|chews|gummies|candy|fruit snack|snack mix|snacks?|trail mix|pretzels?|nut butter|dog food|gels?|jerky|granola)\b/, "food"],
  [/\b(meals?|dinner|breakfast|lunch|ramen|noodles|oatmeal|oats)\b/, "meal"],

  // tools
  [/\b(knife|saw|multi[- ]?tool|sheath|scissors)\b/, "knife"],
  [/\b(ice axe|ice tool|piolet)\b/, "iceAxe"],
  [/\b(repair kit|repair patches|patches|repair buckle|buckle|duct tape|repair tape|tenacious tape|gear tape|sewing kit|sewing awl|screwdriver|zipper pulls)\b/, "repair"],

  // electronics and light
  [/\b(headlamp|flashlight|torch|lantern|lights?)\b/, "light"],
  [/\b(smartwatch|gps watch|watch)\b/, "watch"],
  [/\b(phone|smartphone|iphone|gps handheld|gps|satellite messenger|satellite communicator|personal locator beacon|plb|inreach|e-reader|kindle)\b/, "phone"],
  [/\b(earbuds|airpods|earphones|headphones)\b/, "earbuds"],
  [/\bcamera\b/, "camera"],
  [/\b(power bank|battery|battery pack|wall charger|charger|solar|solar panel|charging cable|cable|air pump|inflator|pump)\b/, "electronics"],

  // body
  [/\b(blister care|moleskin|tape|leukotape|bandages?|tick remover|tweezers|antacid|pills?|medication)\b/, "firstAid"],
  [/\b(trowel|shovel|wipes?|toilet paper|pee cloth|bidet|tissues?|waste tablets|bathroom kit)\b/, "toilet"],
  [/\btowels?\b/, "towel"],
  [/\b(toothbrush|toothpaste|sunscreen|spf\d*|lip balm|deodorant|balm|salve|lotion|cream|moisturi[sz]er|cleanser|soap|sanitizer|bite relief|insect repellent|repellent|bug spray|deet|permethrin|hairbrush|brush|nail clippers)\b/, "toiletry"],

  // a jar, a container, a cooler: after the toiletries, so "cleanser + container" is a
  // toiletry and only a bare container is one
  [/\b(jar|container|cooler)\b/, "container"],

  // camp
  [/\b(camp chair|chair|camp stool|stool|table)\b/, "chair"],
  [/\b(carabiner|gear hooks?)\b/, "carabiner"],
  [/\b(card game|cards|games?|chess|dice|cribbage)\b/, "games"],

  // a bag or a case of anything not named above: after every rule that knows what
  // the case holds, so a camera case is a camera and a pack liner a bag
  [/\bwallet\b/, "wallet"],
  [/\b(stuff sack|compression sack|dry bag|pack liner|pouch|packing cubes?|zip ?lock|food bag|odou?r[- ]proof bag|smell proof bag|freezer bag|waste bags?|bear bag|ziploc|sack|case|bag)\b/, "bag"],
  [/\b(backpack|daypack|fastpack|duffel|fanny pack|hip pack|chest pack|shoulder pocket|pack|straps)\b/, "backpack"],

  // last, a type that is only a kind's own name ("Shelter", "Toiletries"): everything
  // more specific has had its turn, so "Water filter" is still a filter
  [/^(shelter)$/, "tent"],
  [/^(sleep|sleep system)$/, "sleep"],
  [/^(storage)$/, "bag"],
  [/^(clothing|clothes|apparel)$/, "shirt"],
  [/^(footwear)$/, "shoe"],
  [/^(water)$/, "bottle"],
  [/^(kitchen|cooking|cook kit)$/, "pot"],
  [/^(food)$/, "food"],
  [/^(electronics)$/, "electronics"],
  [/^(hygiene|toiletry|toiletries)$/, "toiletry"],
  [/^(trekking)$/, "poles"],
];

function matchRules(words: string): GearGlyph | null {
  for (const [rule, glyph] of RULES) if (rule.test(words)) return glyph;
  return null;
}

// A typed type is as often plural as not ("Bungee cords", "Stuff sacks", "Pouches"),
// and the rules name things one at a time, so a type that matched nothing is read once
// more with its plurals taken off. Only as a second try: "glasses" and "dress" match as
// written and never reach it, and a word ending in "ss" ("compass") is left alone.
// "-ies" and "-ives" come off whole ("batteries" is a battery, "knives" a knife).
const singular = (words: string) =>
  words
    .split(" ")
    .map((w) =>
      w.length <= 3
        ? w
        : /[^aeiou]ies$/.test(w)
          ? `${w.slice(0, -3)}y` // batteries, toiletries, accessories
          : /ives$/.test(w)
            ? `${w.slice(0, -3)}fe` // knives
            : /(?:ch|sh|x|z|ss)es$/.test(w)
              ? w.slice(0, -2)
              : /[^s]s$/.test(w)
                ? w.slice(0, -1)
                : w,
    )
    .join(" ");

// Remembered per spelling: the walk above is ninety regexes (twice on a miss), every
// row of a list or a vault asks it on every render, and a search of My Gear asks it for
// every row on every keystroke. Emptied when it fills, so a server that sees every
// typed gear type there is can't grow it without bound.
const seen = new Map<string, GearGlyph | null>();
const SEEN_MAX = 2000;

function glyphOf(text: string | null | undefined): GearGlyph | null {
  const words = (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!words) return null;
  let glyph = seen.get(words);
  if (glyph === undefined) {
    const one = singular(words);
    glyph = matchRules(words) ?? (one !== words ? matchRules(one) : null);
    if (seen.size >= SEEN_MAX) seen.clear();
    seen.set(words, glyph);
  }
  return glyph;
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
