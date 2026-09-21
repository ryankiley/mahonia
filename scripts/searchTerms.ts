// Search-side vocabulary: the extra words a catalog row should be findable by
// beyond its brand + model name. Two problems it solves, both search-only (no UI):
//
// BUILD-TIME ONLY, which is why it lives here and not in shared/. Everything it
// produces is materialized into catalog_items.search_terms at seed time, so the
// only callers are build-catalog and catalogCsv — nothing under app/ or server/
// imports it at request time. It sat in shared/ (which means "the browser and the
// server both need this, identically, while serving a request") for long enough to
// imply a runtime role it never had. Its sibling scripts/gearTypes.ts is the same
// kind of thing, filed correctly.
//
//   1. CATEGORY search — a tent is named "Copper Spur" / "X-Mid", never "tent", so
//      typing "tent" finds nothing. We derive a canonical noun for each row and
//      materialize it into catalog_items.search_terms at seed time, so the fuzzy
//      search (which matches brand + name + search_terms) can hit it.
//   2. LOCALE / SYNONYM search — a UK user types "rucksack", a US user types
//      "backpack"; both should find the same packs. We fold every alias that points
//      at a noun into that noun's search_terms, so either term matches.
//   3. WHAT-IT-IS search — a row is always findable by its own gear type. The noun
//      vocabulary below is ~100 words against ~350 hand-authored gear types, so
//      before 2026-09-20 a fifth of the catalog (GPS watches, trail runners, phones,
//      sunscreen, camp chairs …) resolved to no noun at all and could only be found
//      by typing the brand or model. The gear type is folded into every row's terms
//      beside the noun, and EXTRA_TERMS hangs the regional words off either.
//
// The noun is derived from the product name where the name carries a gear word,
// and falls back to a conservative per-category default where the name is
// model-only. This is deliberately NOT the item's gear type (the label shown under a
// product name — scripts/gearTypes.ts): these words only feed SEARCH, hence the
// search-scoped name. A row is found by its search_terms and never by its gear type,
// so the two vocabularies need only stay consistent, not identical — the better
// display term wins there ("neck gaiter"), the better recall term wins here ("buff").

// Canonical gear nouns, lowercase. Matching is case-insensitive on word
// boundaries with an optional trailing "s" — so "Trekking Pole" derives
// "trekking poles", "Sock" derives "socks", and "Tentacle" never derives "tent".
// Longest entry wins ("sleeping bag liner" over "sleeping bag").
const NOUNS = [
  "sleeping bag liner",
  "sleeping bag",
  "sleeping pad",
  "pack liner",
  "pack cover",
  "bear canister",
  "bear bag",
  "food bag",
  "dry bag",
  "stuff sack",
  "fanny pack",
  "trekking poles",
  "tent poles",
  "water filter",
  "water bottle",
  "water bladder",
  "fuel canister",
  "first aid kit",
  "repair kit",
  "power bank",
  "earbuds",
  "headphones",
  "rain jacket",
  "rain pants",
  "wind jacket",
  "wind pants",
  "down jacket",
  "base layer",
  "bug net",
  "head net",
  "neck gaiter",
  "ice axe",
  "camp shoes",
  "dog bowl",
  "tent",
  "tarp",
  "bivy",
  "hammock",
  "quilt",
  "pillow",
  "groundsheet",
  "backpack",
  "daypack",
  "headlamp",
  "flashlight",
  "lantern",
  "stove",
  "pot",
  "pan",
  "mug",
  "cup",
  "bowl",
  "spoon",
  "spork",
  "fork",
  "knife",
  "bottle",
  "flask",
  "stakes",
  "guyline",
  "poncho",
  "umbrella",
  "gaiters",
  "crampons",
  "microspikes",
  "jacket",
  "hoodie",
  "fleece",
  "vest",
  "shirt",
  "pants",
  "shorts",
  "skirt",
  "socks",
  "shoes",
  "boots",
  "sandals",
  "gloves",
  "mittens",
  "beanie",
  "balaclava",
  "hat",
  "cap",
  "sunglasses",
  "towel",
  "trowel",
  "toothbrush",
  "charger",
  "cable",
  "tripod",
  "camera",
  "compass",
  "whistle",
  "lighter",
  "matches",
  "carabiner",
  "cord",
  "leash",
] as const;

// Product-name / query tokens that mean the SAME thing as a canonical noun —
// regional variants ("rucksack" = backpack) and colloquial synonyms ("puffy" =
// down jacket). A row's search_terms includes both its noun AND every alias that
// points at that noun, so a search for either term matches.
// A word that, in a product NAME, always names this thing — checked against every
// catalog name, and re-checked when the catalog grows: an alias that fires on the
// wrong product relabels it. Words that a maker also uses as a model word for
// something else are NOT here; they are search-only extras below ("torch" — Soto's
// Pocket Torch is a lighter; "mat" — a Tent Vestibule Mat; "hoody" — Arc'teryx's
// Cerium Hoody is a down jacket; "puffy" — a synthetic jacket as often as down).
// An alias's target is always a NOUN, never another alias (termsFor follows one hop).
const ALIASES: Record<string, string> = {
  "air mattress": "sleeping pad",
  "sleeping mat": "sleeping pad",
  mattress: "sleeping pad",
  "head torch": "headlamp",
  rucksack: "backpack",
  "torso pad": "sleeping pad",
  "wind shirt": "wind jacket",
  battery: "power bank",
  earphones: "earbuds",
  headset: "headphones",
  toque: "beanie",
  // 2026-09-20
  footprint: "groundsheet",
  "camp sandal": "sandals", // Gnuhr's "Footprint Camp Sandal" is a sandal, not a groundsheet
  "hip pack": "fanny pack",
  buff: "neck gaiter",
  reservoir: "water bladder",
  "water reservoir": "water bladder",
  "foam pad": "sleeping pad",
};

// Search-only vocabulary, keyed by the canon it belongs to — a NOUN above, or a gear
// type as scripts/gearTypes.ts spells it, lowercased ("gps watch", "trail runners").
// These are the words a searcher TYPES for a thing and are never read out of a
// product name, for two reasons a matcher can't handle: a maker uses the word as a
// model word for something else ("Down Sweater" is a down jacket, "Windshield" a pair
// of sunglasses, "Wind Shell Jacket" a wind jacket, "Cutlery Spoon" a spoon), or the
// word belongs to more than one noun ("puffy" is any insulated jacket, "puffer" too).
// Regional English first — UK/IE, AU/NZ, CA, ZA, IN — then US trail slang, then the
// trademarks that became the word. A brand whose own rows are in the catalog is never
// a generic term for other makers' rows — the ranker caps a kind-of-gear query at two
// rows per brand, so "sawyer" on every filter would hide Sawyer's own line — with
// these declared exceptions, each the ordinary word for the thing and a brand of one
// to three rows that exact-name ranking still puts first: buff, crocs, chapstick,
// camelback, body glide, leukotape, tenacious tape, kula cloth. (ziploc, shewee,
// compeed, polartec, gotoob, opsak, schnozzel, speedy stitcher, crunchit have no rows
// to hide.) A key that is neither a noun nor a live gear type is dead vocabulary;
// tests/catalog-data.test.ts refuses it.
//
// A list attaches to a row through its gear type always, and through the noun read
// out of its NAME only when that noun IS its type (after alias resolution). A name
// word that disagrees with the type is a model word — "Pot Cozy", "Compression Cap",
// "Eye Jacket" sunglasses, "Hiker Boot" socks — and carrying the whole pot / cap /
// jacket / boots vocabulary onto those rows put nine pot cozies in the top twelve for
// "saucepan" (2026-09-20). The noun and its ALIASES still attach (they always did).
export const EXTRA_TERMS: Record<string, readonly string[]> = {
  // — sleep —
  "sleeping pad": ["mat", "air pad", "air mat", "camping mat", "roll mat", "inflatable mat", "inflatable pad", "sleep mat", "sleep pad", "camp mat", "closed cell foam", "ccf", "ccf pad", "self inflating mat", "self-inflating mat", "self inflating pad", "foam mat", "carry mat", "carrymat"],
  "sleeping bag": ["mummy bag", "sleep bag", "sleeping sack", "down bag", "synthetic bag"],
  "sleeping bag liner": ["sleep sack", "bag liner", "silk liner", "thermal liner", "sleeping liner"],
  quilt: ["top quilt", "backpacking quilt", "down quilt", "camping quilt", "underquilt", "under quilt"],
  pillow: ["camp pillow", "camping pillow", "inflatable pillow", "backpacking pillow"],
  blanket: ["camp blanket", "camping blanket", "throw"],
  sheet: ["bed sheet", "fitted sheet", "mattress sheet"],
  "sit pad": ["seat pad", "sitting pad", "sit mat", "seat mat", "foam seat", "bum pad", "butt pad", "sit cushion"],
  // — shelter —
  tent: ["backpacking tent", "camping tent", "hiking tent", "trekking pole tent", "freestanding tent", "shelter"],
  tarp: ["rain fly", "flysheet", "fly sheet", "tarp shelter", "flat tarp", "a-frame tarp", "hex tarp", "hoochie", "hootchie", "hootch", "basha"],
  bivy: ["bivvy", "bivi", "bivy sack", "bivvy bag", "bivi bag", "bivy bag", "bivouac"],
  groundsheet: ["ground sheet", "ground cloth", "groundcloth", "tyvek", "polycro"],
  "inner tent": ["inner", "nest", "mesh inner", "net inner", "bug inner", "mesh nest"],
  stakes: ["pegs", "tent pegs", "tent stakes", "tent peg", "ground stakes", "ti stakes"],
  "tent stakes": ["pegs", "tent pegs", "tent peg", "peg", "stakes", "ground stakes", "ti stakes", "titanium stakes"],
  guyline: ["guy line", "guy lines", "guy rope", "guyrope", "guy ropes", "guy cord", "tent line"],
  "bug net": ["mosquito net", "mozzie net", "midge net", "insect net", "bug bivy", "net tent", "mesh tent", "bug shelter", "sandfly net"],
  "head net": ["mosquito head net", "midge head net", "bug head net", "headnet", "midge hood", "mosquito hood", "midge net", "bug hat", "mosquito hat", "sandfly net", "fly net", "fly veil", "bug veil"],
  hammock: ["camping hammock", "backpacking hammock", "hammock tent"],
  "hammock straps": ["tree straps", "suspension straps", "hammock suspension", "whoopie slings", "whoopies"],
  vestibule: ["porch", "tent porch", "tent vestibule"],
  "rigging kit": ["tie out kit", "tie-out kit", "pitching kit"],
  // — packs and bags —
  backpack: ["knapsack", "hiking pack", "backpacking pack", "trekking pack", "tramping pack", "bushwalking pack", "overnight pack", "multi-day pack", "multiday pack", "trekking bag", "hiking bag", "bagpack", "bag pack", "bergen", "rucsac", "ruck"],
  daypack: ["daysack", "day pack", "day bag", "summit pack"],
  "fanny pack": ["bum bag", "bumbag", "waist pack", "waist bag", "waist pouch", "belt bag", "hip bag", "lumbar pack", "lumbarpack", "hipbelt pack", "moon bag", "moonbag"],
  fastpack: ["fast pack", "running pack", "fastpacking pack", "race pack"],
  "running vest": ["race vest", "hydration vest", "trail vest", "running pack", "trail running vest", "vest pack"],
  "hydration pack": ["hydration backpack", "camelback", "bladder pack"],
  "sling bag": ["crossbody bag", "cross body bag", "shoulder bag", "sling"],
  "chest pack": ["chest rig", "chest bag", "front pack"],
  "tote bag": ["tote", "carry bag", "shopping bag"],
  duffel: ["duffle", "duffel bag", "duffle bag", "holdall", "kit bag", "gear bag", "tog bag", "togbag"],
  "dog pack": ["dog backpack", "dog saddlebag", "dog harness pack"],
  "pack cover": ["rain cover", "raincover", "pack rain cover", "pack raincover", "rucksack cover", "backpack cover", "backpack rain cover", "waterproof cover"],
  "pack liner": ["liner bag", "trash compactor bag", "compactor bag", "bin liner", "waterproof liner", "pack liner bag"],
  "stuff sack": ["ditty bag", "stuffsack", "stuff bag", "storage sack", "storage bag", "gear sack", "sack"],
  "compression sack": ["compression bag", "compression stuff sack", "compression dry bag"],
  "dry bag": ["dry sack", "drybag", "roll top bag", "roll-top bag", "waterproof bag", "waterproof sack", "roll top dry bag", "drysack"],
  pouch: ["zip pouch", "zipper pouch", "organizer pouch", "organiser pouch", "accessory pouch", "gear pouch", "ditty"],
  wallet: ["card holder", "cardholder", "card wallet", "billfold", "purse", "money clip"],
  "packing cubes": ["packing cube", "packing cell", "packing cells", "clothes cube", "organizer cube", "organiser cube"],
  "shoulder pocket": ["shoulder strap pocket", "strap pocket", "shoulder pouch", "chest pocket"],
  "hip belt pocket": ["hipbelt pocket", "hip pocket", "belt pocket", "waist belt pocket", "hip belt pouch"],
  "pack pocket": ["external pocket", "add-on pocket", "bottom pocket", "top pocket"],
  "phone pocket": ["phone pouch", "phone sleeve", "phone holster"],
  "snack pouch": ["snack bag", "snack sack", "feed bag", "trail food pouch", "snack pocket"],
  "food bag": ["food sack", "food storage bag", "food stuff sack", "food hang bag"],
  "bear bag": ["food hang bag", "hang bag", "bear resistant bag", "bear-resistant bag", "kevlar bag"],
  "bear canister": ["bear can", "bear barrel", "bear bin", "food canister", "bear proof canister", "bear-proof canister"],
  "bear hang kit": ["bear hang", "food hang kit", "hang kit", "pct hang", "bear hanging kit"],
  "odor-proof bag": ["odour-proof bag", "odor proof bag", "odour proof bag", "smell proof bag", "scent proof bag", "opsak"],
  "freezer bag": ["ziploc", "ziplock", "zip lock bag", "ziplock bag", "zip bag", "resealable bag", "sandwich bag", "zipper bag", "snap lock bag", "snaplock bag"],
  "toiletry bag": ["wash bag", "washbag", "toiletries bag", "dopp kit", "dopp bag", "sponge bag", "hygiene kit", "toiletry kit"],
  "first aid pouch": ["first aid bag", "med pouch", "medical pouch", "first-aid pouch"],
  case: ["hard case", "carry case", "protective case", "travel case"],
  container: ["box", "tub", "storage container", "bucket"],
  // — cook —
  stove: ["burner", "cooker", "camp stove", "camping stove", "backpacking stove", "gas stove", "canister stove", "alcohol stove", "spirit burner", "meths burner", "meths stove", "metho stove", "metho burner", "white gas stove", "liquid fuel stove", "multi fuel stove", "multi-fuel stove", "kerosene stove", "shellite stove", "naphtha stove", "wood stove", "camp cooker"],
  "stove system": ["cook system", "integrated stove", "cooking system", "stove kit"],
  "fuel canister": ["gas canister", "gas cartridge", "gas cylinder", "camping gas", "isobutane", "fuel can", "gas can", "gas", "canister", "cylinder", "propane", "butane"],
  "fuel bottle": ["alcohol bottle", "meths bottle", "metho bottle", "spirit bottle", "fuel flask", "white gas bottle"],
  "fuel tablets": ["hexamine", "solid fuel", "fuel tabs", "hexi tablets", "hexi blocks"],
  "fuel transfer valve": ["canister refill", "gas transfer", "refill adapter", "fuel transfer"],
  "canister stand": ["fuel stand", "gas stand", "stove stand", "canister feet", "stove feet"],
  pot: ["billy", "billy can", "billycan", "cook pot", "cooking pot", "saucepan", "cookpot", "camp pot"],
  kettle: ["tea kettle", "camp kettle", "camping kettle", "billy", "billy can"],
  pan: ["skillet", "fry pan", "frypan"],
  "frying pan": ["skillet", "fry pan", "frypan"],
  mug: ["camp mug", "camping mug", "insulated mug", "coffee mug"],
  cup: ["camp cup", "drinking cup", "tumbler", "beaker"],
  bowl: ["camp bowl", "dish", "camping bowl"],
  plate: ["camp plate", "camping plate", "dish"],
  spoon: ["long spoon", "long handle spoon", "long handled spoon", "long-handled spoon", "camp spoon"],
  spork: ["camp spork", "foon"],
  utensils: ["cutlery", "silverware", "flatware", "utensil set", "cutlery set", "eating utensils", "utensil"],
  chopsticks: ["chop sticks", "camp chopsticks"],
  cookset: ["cook set", "cookware", "cooking set", "mess kit", "mess tin", "mess tins", "cook kit", "cooking kit", "pot set", "camp cookware"],
  windscreen: ["windshield", "wind screen", "wind shield", "stove windscreen", "wind guard", "windguard"],
  "pot cozy": ["pot cosy", "cosy", "cozy", "koozie", "insulating cozy", "pot koozie"],
  "food cozy": ["food cosy", "meal cozy", "meal cosy", "pouch cozy", "freezer bag cozy", "meal pouch cozy"],
  "foam pad": ["foam mat", "carry mat", "carrymat", "ccf", "ccf pad", "closed cell foam", "roll mat", "z-lite", "zlite"],
  "pot lifter": ["pot gripper", "pot grabber", "pan handle", "pot handle", "gripper"],
  "pot lid": ["lid", "pan lid", "pot cover"],
  "coffee maker": ["coffee press", "pour over", "pour-over", "coffee dripper", "camp coffee", "espresso maker"],
  "french press": ["coffee press", "cafetiere", "cafetière", "plunger", "coffee plunger"],
  "coffee filter": ["pour over", "pour-over", "coffee dripper", "filter holder"],
  "instant coffee": ["coffee", "coffee sachets", "coffee packets", "coffee sticks"],
  knife: ["pocket knife", "pocketknife", "penknife", "pen knife", "folding knife", "swiss army knife", "blade"],
  sunglasses: ["sunnies", "shades", "sun glasses", "glasses", "eyewear", "specs", "goggles"],
  lighter: ["mini lighter", "camp lighter", "fire lighter", "torch lighter"],
  matches: ["waterproof matches", "stormproof matches", "storm matches"],
  "fire starter": ["firestarter", "fire steel", "ferro rod", "ferrocerium rod", "flint", "flint and steel", "tinder", "firesteel"],
  jar: ["mini jar", "spice jar", "condiment jar", "small container"],
  funnel: ["mini funnel", "fuel funnel", "folding funnel"],
  // — water —
  "water filter": ["filter", "purifier", "water purifier", "squeeze filter", "gravity filter", "water purification", "inline filter", "filter system"],
  "water treatment": ["purification tablets", "water purification tablets", "chlorine dioxide", "purification drops", "water drops", "water tabs", "purification tabs", "sterilising tablets", "sterilizing tablets", "water purifier"],
  "water bladder": ["hydration bladder", "hydration reservoir", "bladder", "water container", "water carrier", "water jug", "water bag", "hydration system", "camelback", "hydration reservior"],
  "water bottle": ["drink bottle", "drinks bottle", "hydration bottle", "sports bottle", "sipper", "sipper bottle", "canteen", "bidon", "bottle"],
  "soft flask": ["collapsible bottle", "soft bottle", "flexible bottle", "collapsible flask", "hydration flask"],
  "squeeze bottle": ["squeeze bag", "squeeze pouch", "filter bag"],
  "bottle cap": ["bottle lid", "sport cap", "sports cap", "flip cap", "bottle top"],
  "bottle holder": ["bottle pocket", "bottle carrier", "bottle mount", "bottle pouch"],
  "bottle sleeve": ["bottle pocket", "bottle carrier", "bottle pouch", "bottle jacket", "bottle insulator"],
  hose: ["drink tube", "hydration tube", "bladder tube", "drinking tube", "tube", "hydration hose", "bite valve"],
  straw: ["filter straw", "water straw", "drinking straw", "straw filter"],
  "filter cap": ["filter adapter", "filter lid", "bottle filter"],
  "cleaning coupling": ["backflush adapter", "backflush coupling", "cleaning adapter", "backwash coupling"],
  "tube clip": ["hose clip", "tube holder", "hose holder", "magnetic clip"],
  "tube insulator": ["hose insulator", "tube cover", "hose cover", "insulated tube"],
  // — walking, traction, poles —
  "trekking poles": ["hiking poles", "walking poles", "tramping poles", "trekking sticks", "hiking sticks", "walking sticks", "nordic poles", "trail poles", "carbon poles", "trekking pole"],
  "hiking staff": ["walking staff", "walking stick", "hiking stick", "staff", "trekking staff", "monopod staff"],
  "ice axe": ["ice tool", "piolet", "ice ax", "mountaineering axe", "walking axe"],
  crampons: ["crampon", "mountaineering spikes", "ice spikes", "climbing spikes"],
  microspikes: ["spikes", "micro spikes", "ice cleats", "cleats", "traction", "traction devices", "trail crampons", "ice grips", "ice grippers", "snow grips"],
  gaiters: ["leg gaiters", "ankle gaiters", "shoe gaiters", "trail gaiters", "gaiter"],
  snowshoes: ["snow shoes", "snowshoe"],
  "snow stakes": ["snow pegs", "snow anchors", "deadman", "deadmen"],
  "snow anchors": ["snow stakes", "deadman", "deadmen", "snow pegs"],
  // — clothing: outer —
  "rain jacket": ["waterproof jacket", "waterproofs", "hardshell", "hard shell", "shell jacket", "shell", "rain shell", "raincoat", "rain coat", "cagoule", "anorak", "smock", "parka", "rain parka", "spray jacket", "walking jacket", "hiking jacket", "rainwear", "rain wear", "waterproof shell", "wet weather jacket", "storm jacket", "rain gear"],
  "rain pants": ["waterproof trousers", "rain trousers", "overtrousers", "over trousers", "waterproof pants", "overpants", "over pants", "waterproof overtrousers", "shell pants", "hardshell pants", "rain pant", "wet weather pants", "salopettes", "bib pants", "bibs"],
  "rain skirt": ["rain kilt", "kilt", "rain wrap", "hiking kilt", "waterproof skirt"],
  "rain chaps": ["chaps", "rain leg gaiters", "waterproof chaps", "leg chaps"],
  "rain mitts": ["rain mittens", "waterproof mitts", "shell mitts", "over mitts", "overmitts", "waterproof mittens"],
  "rain cap": ["waterproof cap", "rain hat", "waterproof hat"],
  "rain suit": ["waterproofs", "rain set", "rain gear", "waterproof suit"],
  poncho: ["rain poncho", "cape", "rain cape", "poncho tarp"],
  "poncho tarp": ["rain poncho", "poncho", "tarp poncho"],
  umbrella: ["brolly", "rain umbrella", "trekking umbrella", "hiking umbrella", "parasol", "sun umbrella", "trail umbrella", "chrome dome"],
  "umbrella mount": ["umbrella holder", "umbrella clamp", "hands free umbrella", "hands-free umbrella"],
  "wind jacket": ["windbreaker", "wind breaker", "windshirt", "wind shell", "windshell", "windcheater", "wind cheater", "windproof jacket", "anorak", "spray jacket"],
  "wind pants": ["wind trousers", "windproof trousers", "windpants", "wind pant", "windproof pants"],
  "wind shirt": ["windshirt", "wind shell", "windshell", "windbreaker", "wind jacket"],
  "softshell hoodie": ["softshell jacket", "soft shell", "softshell", "soft-shell jacket", "softshell hoody"],
  jacket: ["coat"],
  "down jacket": ["puffy", "puffer", "puffer jacket", "puffy jacket", "down coat", "down parka", "down puffy", "down hoody", "down hoodie", "insulated jacket", "feather jacket", "belay jacket"],
  "insulated jacket": ["puffy", "puffer", "puffer jacket", "puffy jacket", "synthetic puffy", "insulated coat", "insulation jacket", "synthetic jacket", "active insulation", "belay jacket"],
  "synthetic jacket": ["puffy", "puffer", "puffer jacket", "puffy jacket", "synthetic puffy", "synthetic insulated jacket", "insulated jacket", "active insulation"],
  vest: ["gilet", "bodywarmer", "body warmer", "sleeveless jacket", "insulated vest", "down vest", "puffy vest", "puffer vest", "jerkin"],
  "down pants": ["insulated pants", "puffy pants", "down trousers", "insulated trousers", "puffer pants"],
  // — clothing: mid and base —
  fleece: ["jumper", "sweater", "jersey", "pullover", "midlayer", "mid layer", "mid-layer", "fleece jacket", "fleece top", "fleece hoodie", "fleece hoody", "grid fleece", "polartec", "alpha fleece"],
  hoodie: ["hoody", "hooded top", "hooded sweatshirt", "sweatshirt", "hooded fleece", "hoodies", "bunnyhug", "bunny hug"],
  "sun hoodie": ["sun hoody", "hooded sun shirt", "sun top", "upf hoodie", "upf hoody", "sun protection hoodie", "sun shirt", "hiking hoodie", "hiking hoody"],
  "sun shirt": ["upf shirt", "sun protection shirt", "sun top", "hiking shirt", "trail shirt", "long sleeve sun shirt"],
  shirt: ["tee", "t-shirt", "tshirt", "t shirt", "long sleeve", "long-sleeve shirt", "full sleeve", "full sleeves", "half sleeve", "button down", "button-down", "long sleeve shirt", "short sleeve shirt", "hiking shirt", "trail shirt", "running top"],
  "running shirt": ["running tee", "running top", "race shirt", "singlet"],
  "tank top": ["singlet", "vest", "vest top", "sleeveless top", "sleeveless shirt", "tank", "sleeveless tee"],
  "base layer": ["thermals", "thermal underwear", "baselayer", "thermal", "merino base layer", "long underwear", "base layers", "under layer", "polyprops", "polypro", "polypropylene", "thermal inners", "thermal inner", "inner wear", "innerwear"],
  "base layer top": ["thermal top", "baselayer top", "base layer shirt", "thermal shirt", "long sleeve base layer", "merino top", "thermal long sleeve", "polyprops", "polypro", "thermal inner", "thermal inners", "innerwear", "full sleeve"],
  "base layer bottoms": ["long johns", "long underwear", "thermal bottoms", "thermal leggings", "thermal trousers", "base layer pants", "baselayer bottoms", "merino leggings", "thermal pants", "longjohns", "polyprops", "polypro", "thermal inners"],
  // — clothing: legs —
  pants: ["trousers", "trekking pants", "hiking pant", "walking pants", "trouser"],
  "hiking pants": ["hiking trousers", "walking trousers", "trekking trousers", "trekking pants", "trail pants", "hiking trouser", "outdoor trousers", "convertible pants", "zip-off pants", "zip off pants", "cargo pants", "cargos", "trousers"],
  shorts: ["hiking shorts", "running shorts", "trail shorts", "half pants", "half pant"],
  leggings: ["tights", "running tights", "yoga pants", "compression tights", "long tights", "running leggings", "hiking leggings", "legging"],
  "half tights": ["running tights", "compression shorts", "bike shorts", "cycling shorts", "spandex shorts", "half tight", "short tights"],
  joggers: ["sweatpants", "sweat pants", "track pants", "trackies", "jogging bottoms", "trackpants", "tracksuit bottoms", "jogger", "lowers"],
  skirt: ["hiking skirt", "running skirt", "skort", "trail skirt"],
  dress: ["hiking dress", "sundress", "sun dress", "trail dress", "running dress"],
  "fleece pants": ["fleece trousers", "fleece bottoms", "fleece leggings", "fleece tights", "fleece pant"],
  // — clothing: small —
  underwear: ["knickers", "undies", "boxers", "boxer briefs", "briefs", "panties", "underpants", "boxer shorts", "underwear bottoms", "smalls", "undershorts", "jocks"],
  "sports bra": ["bra", "bralette", "running bra", "sport bra", "crop bra"],
  socks: ["sock", "hiking socks", "walking socks", "tramping socks", "wool socks", "merino socks", "toe socks", "running socks", "trail socks"],
  "sock liners": ["liner socks", "liner sock", "inner socks", "sock liner"],
  "down socks": ["down booties", "down slippers", "tent socks", "camp socks", "sleep socks"],
  booties: ["down booties", "camp booties", "tent booties", "camp slippers", "slippers", "over booties", "overboots", "hut booties", "hut slippers"],
  "dog booties": ["dog boots", "dog shoes", "paw boots", "paw protectors"],
  gloves: ["glove", "fingerless gloves", "running gloves", "windproof gloves", "hiking gloves", "liner gloves"],
  mittens: ["mitts", "mitten", "overmitts", "over mitts", "shell mitts", "mitt"],
  "sun gloves": ["fingerless gloves", "upf gloves", "sun protection gloves", "fishing gloves"],
  "glove liners": ["liner gloves", "inner gloves", "glove liner", "thin gloves"],
  hat: ["cap", "ball cap", "baseball cap", "running cap", "peaked cap", "hiking cap", "trail cap", "snapback", "hiking hat", "walking hat", "sunhat", "sun hat"],
  "sun hat": ["sunhat", "wide brim hat", "brimmed hat", "boonie hat", "boonie", "brim hat", "hiking hat", "bush hat", "legionnaire hat"],
  "bucket hat": ["bucket", "fishing hat", "giggle hat", "boonie"],
  "trucker hat": ["trucker cap", "mesh cap", "mesh hat", "snapback", "ball cap", "baseball cap"],
  beanie: ["tuque", "woolly hat", "wooly hat", "woolen cap", "woollen cap", "bobble hat", "knit hat", "knitted hat", "skull cap", "skullcap", "winter hat", "warm hat", "wool hat", "fleece hat"],
  balaclava: ["ski mask", "face mask", "face cover", "balaclava hood", "helmet liner", "monkey cap"],
  "neck gaiter": ["snood", "neck tube", "neck warmer", "neckwarmer", "neck scarf", "tube scarf", "muffler"],
  headband: ["ear warmer", "ear band", "sweatband", "head band", "ear warmers", "sweat band"],
  bandana: ["kerchief", "handkerchief", "neckerchief", "hanky", "trail rag", "sweat rag"],
  scarf: ["neck scarf", "wool scarf", "muffler"],
  hood: ["balaclava hood", "hooded cowl", "cowl", "insulated hood", "down hood"],
  belt: ["waist belt", "trouser belt", "webbing belt", "pants belt"],
  "arm sleeves": ["sun sleeves", "arm warmers", "sleeves", "arm covers", "arm sleeve"],
  laces: ["shoelaces", "shoe laces", "bootlaces", "boot laces", "shoelace", "elastic laces", "lock laces"],
  insoles: ["inserts", "shoe inserts", "footbeds", "footbed", "orthotics", "insole", "in-soles", "shoe insoles", "arch support"],
  // — footwear —
  "trail runners": ["trail running shoes", "trail shoes", "running shoes", "trainers", "runners", "joggers", "trail runner", "trail sneakers", "sneakers", "hiking sneakers", "trail running shoe", "tennis shoes", "sports shoes", "trekking shoes", "tramping shoes", "fell shoes", "fell running shoes", "sandshoes", "takkies", "tekkies", "tackies"],
  "hiking shoes": ["walking shoes", "approach shoes", "trekking shoes", "tramping shoes", "hiking shoe", "low hikers", "hikers", "low cut hiking shoes", "trail hikers"],
  "hiking boots": ["walking boots", "hiking boot", "trekking boots", "tramping boots", "bushwalking boots", "hikers", "boot", "backpacking boots", "mid boots", "high top hikers"],
  boots: ["boot", "walking boots", "hiking boots", "trekking boots"],
  shoes: ["shoe", "footwear"],
  sandals: ["flip flops", "flip-flops", "thongs", "jandals", "slides", "sport sandals", "hiking sandals", "sandal", "slippers", "chappals", "slops", "plakkies", "floaters"],
  "camp shoes": ["camp sandals", "crocs", "camp slides", "camp slippers", "camp footwear", "camp shoe", "water shoes", "river shoes", "hut shoes", "thongs", "jandals", "flip flops", "slops"],
  // — electronics —
  headlamp: ["headtorch", "head lamp", "head light", "headlight", "head lamps", "headlamps"],
  flashlight: ["torch", "hand torch", "pocket torch", "handheld light", "flash light", "torch light", "hand light"],
  lantern: ["camp light", "camping lantern", "tent light", "tent lamp", "string lights", "camp lantern", "led lantern"],
  "power bank": ["battery pack", "power pack", "battery bank", "portable charger", "powerbank", "external battery", "usb battery", "portable battery", "battery charger", "phone charger", "backup battery", "spare battery"],
  charger: ["usb charger", "charging brick", "power adapter", "plug", "wall plug", "charging block", "power brick", "usb-c charger", "adapter", "mains charger", "charging plug"],
  "wall charger": ["wall plug", "power adapter", "plug adapter", "charging brick", "charging block", "power brick", "usb charger", "mains charger", "mains adapter", "plug"],
  cable: ["usb cable", "lead", "charging lead", "usb lead", "charging cord", "usb cord"],
  "charging cable": ["charging lead", "usb lead", "usb cable", "phone cable", "lightning cable", "usb-c cable", "charging cord", "usb cord", "lead"],
  headphones: ["over ear headphones", "over-ear headphones", "on-ear headphones", "wireless headphones", "bluetooth headphones", "earphones"],
  earbuds: ["ear buds", "in-ear headphones", "in ear headphones", "in-ears", "wireless earbuds", "buds", "bluetooth earbuds", "true wireless", "ear phones", "headphones"],
  earplugs: ["ear plugs", "earplug", "ear plug", "sleep plugs"],
  phone: ["cell phone", "cellphone", "mobile phone", "mobile", "smartphone", "smart phone", "cell", "handphone", "android phone"],
  "phone case": ["phone cover", "phone protector", "phone shell"],
  "phone holder": ["phone mount", "phone clip", "phone strap", "phone tether"],
  smartwatch: ["smart watch", "watch", "fitness tracker", "activity tracker", "wearable"],
  "gps watch": ["sports watch", "sport watch", "running watch", "fitness watch", "multisport watch", "gps sports watch", "adventure watch", "outdoor watch", "hiking watch", "abc watch", "watch", "trail watch", "multi-sport watch"],
  "gps handheld": ["gps", "handheld gps", "gps unit", "gps device", "gps receiver", "satnav", "sat nav", "navigator", "handheld navigator", "gps navigator"],
  "satellite messenger": ["satellite communicator", "sat messenger", "sat comm", "sat communicator", "satellite device", "beacon", "emergency beacon", "two-way satellite messenger", "satellite texter", "sat phone", "satellite phone"],
  plb: ["personal locator beacon", "locator beacon", "emergency beacon", "beacon", "rescue beacon", "distress beacon", "epirb"],
  "e-reader": ["ereader", "e reader", "ebook reader", "e-book reader", "reader"],
  camera: ["action camera", "action cam", "point and shoot", "mirrorless", "compact camera"],
  "camera case": ["camera bag", "camera pouch", "lens case"],
  "camera clip": ["camera holster", "camera mount", "strap clip", "camera clip mount"],
  "lens adapter": ["filter adapter", "step-up ring", "lens ring"],
  tripod: ["mini tripod", "travel tripod", "phone tripod"],
  monocular: ["spotting scope", "scope", "pocket scope"],
  binoculars: ["binos", "bins", "field glasses", "binocular"],
  "air pump": ["inflator", "pad pump", "pump", "inflation pump", "electric pump", "mattress pump", "mini pump", "pad inflator"],
  "inflation bag": ["pump sack", "pump bag", "inflation sack", "inflating bag", "air bag", "schnozzel"],
  "pump nozzles": ["pump adapter", "pump adaptor", "valve adapter", "inflator nozzle"],
  compass: ["baseplate compass", "orienteering compass", "navigation compass"],
  whistle: ["emergency whistle", "safety whistle", "rescue whistle", "pea-less whistle"],
  thermometer: ["temperature gauge", "temp gauge", "outdoor thermometer"],
  inclinometer: ["slope meter", "clinometer", "slope gauge", "angle finder"],
  "glow marker": ["glow stick", "glowstick", "trail marker", "glow tag"],
  // — first aid and repair —
  "first aid kit": ["first-aid kit", "medical kit", "med kit", "fak", "first aid", "first aid box", "ifak", "trauma kit", "medkit"],
  "blister care": ["blister plasters", "blister pads", "blister kit", "plasters", "bandaids", "band-aids", "band aids", "bandages", "blister patches", "blister treatment", "compeed", "blister plaster"],
  moleskin: ["mole skin", "blister pads", "blister padding", "foot padding"],
  tape: ["leukotape", "sports tape", "athletic tape", "kt tape", "kinesiology tape", "medical tape", "strapping tape", "blister tape", "zinc oxide tape", "micropore"],
  "duct tape": ["gaffer tape", "gaffa tape", "gorilla tape", "repair tape", "duck tape", "gaff tape"],
  tweezers: ["tweezer", "tick tweezers", "splinter tweezers"],
  "tick remover": ["tick key", "tick tool", "tick puller", "tick twister", "tick hook", "tick card"],
  scissors: ["shears", "snips", "trauma shears", "mini scissors", "folding scissors"],
  antacid: ["antacids", "heartburn tablets", "tums", "indigestion tablets", "rennie"],
  "bite relief": ["sting relief", "itch relief", "bite cream", "anti-itch", "anti itch", "insect bite relief", "bite stickers"],
  "emergency blanket": ["space blanket", "foil blanket", "mylar blanket", "survival blanket", "thermal blanket", "emergency bivy", "survival bag", "emergency bag"],
  "repair kit": ["patch kit", "field repair kit", "gear repair kit", "tent repair kit", "pad repair kit", "mattress repair kit"],
  "repair patches": ["patches", "gear patches", "tenacious tape", "repair tape", "tent patches", "pad patches", "patch", "sticker patches", "puncture patches"],
  "repair buckle": ["field repair buckle", "replacement buckle", "buckle repair", "strap repair"],
  buckle: ["clip", "side release buckle", "ladder lock", "ladderlock", "g-hook", "g hook", "strap buckle"],
  "zipper pulls": ["zip pulls", "zipper pull", "zip pull", "zip tags", "zipper tabs"],
  "sewing kit": ["needle and thread", "repair sewing kit", "sewing repair kit", "mending kit"],
  "sewing awl": ["awl", "speedy stitcher", "stitching awl", "leather awl"],
  "rubber bands": ["elastic bands", "rubber band", "elastics", "elastic band", "gear bands", "silicone bands"],
  straps: ["gear straps", "ski straps", "lash straps", "utility straps", "cinch straps", "strap", "webbing straps", "tie down straps"],
  "compression straps": ["pack straps", "cinch straps", "side straps", "webbing straps"],
  "shoulder straps": ["pack straps", "shoulder harness", "harness", "replacement straps"],
  "sternum strap": ["chest strap", "chest clip", "sternum clip"],
  "hip belt": ["hipbelt", "waist belt", "waistbelt", "pack belt", "replacement hip belt"],
  "bungee cord": ["shock cord", "elastic cord", "bungee", "bungie", "shockcord", "bungee cords"],
  cord: ["cordage", "utility cord", "accessory cord", "guy cord", "dyneema cord", "rope", "spectra cord"],
  paracord: ["550 cord", "parachute cord", "para cord", "cordage", "rope"],
  "cord reel": ["cord winder", "line winder", "cord spool", "cord organizer", "cord organiser", "line reel"],
  "line tensioner": ["tensioner", "linelock", "line lock", "guyline tensioner", "cord tensioner", "guy line adjuster", "cord lock", "cordlock", "line loc"],
  carabiner: ["karabiner", "krab", "clip", "mini carabiner", "wire gate", "wiregate", "snap hook", "biner"],
  "gear hooks": ["gear hook", "hanger", "hangers", "pack hooks", "hooks", "s hook", "s-hook", "gear hanger"],
  // — hygiene —
  sunscreen: ["sunblock", "sun cream", "suncream", "sun screen", "spf", "sun lotion", "sunscreen lotion", "sun block", "sun protection", "sunscreen cream", "zinc", "zinc cream"],
  "sunscreen stick": ["sun stick", "sunblock stick", "spf stick", "sunscreen balm", "face stick", "zinc stick", "zinc"],
  "lip balm": ["lip salve", "chapstick", "lipbalm", "lip protection", "spf lip balm", "lip sunscreen", "lipsalve", "lip cream", "lip chap"],
  "insect repellent": ["bug spray", "insect spray", "mosquito repellent", "deet", "picaridin", "bug repellent", "mozzie spray", "mozzie repellent", "midge repellent", "sandfly repellent", "sandfly", "sandflies", "bug dope", "repellant", "insect repellant", "bug repellant", "mosquito spray", "insect repellent spray", "tick repellent", "bug juice"],
  "anti-chafe balm": ["anti chafe", "anti-chafe", "chafe balm", "chafing cream", "chamois cream", "anti chafing", "chafe stick", "anti-chafing", "body glide", "chafing balm", "chafe cream"],
  "skin salve": ["hand salve", "healing salve", "ointment", "skin balm", "foot balm", "salve", "hand cream", "foot cream", "balm"],
  deodorant: ["antiperspirant", "anti-perspirant", "deo", "deodorant stick", "roll on", "roll-on"],
  "toothpaste tablets": ["toothpaste tabs", "tooth tabs", "toothpaste bits", "tooth tablets", "toothy tabs", "chewable toothpaste"],
  "toothpaste tube": ["travel toothpaste", "toothpaste", "mini toothpaste", "refillable tube"],
  toothpaste: ["tooth paste", "travel toothpaste", "mini toothpaste"],
  toothbrush: ["tooth brush", "travel toothbrush", "folding toothbrush", "bamboo toothbrush", "mini toothbrush"],
  "toothbrush case": ["toothbrush cover", "toothbrush holder", "toothbrush cap", "brush cover"],
  soap: ["camp soap", "biodegradable soap", "soap sheets", "soap leaves", "body wash", "castile soap", "soap powder", "wash", "shampoo", "all purpose soap", "all-purpose soap", "travel soap"],
  "soap case": ["soap dish", "soap box", "soap holder", "soap container", "soap tin"],
  "hand sanitizer": ["hand sanitiser", "sanitizer", "sanitiser", "hand gel", "alcohol gel", "hand rub", "sanitizing gel", "sanitising gel", "antibacterial gel"],
  wipes: ["wet wipes", "baby wipes", "body wipes", "wipe", "shower wipes", "bath wipes", "cleansing wipes", "face wipes", "hand wipes", "moist wipes", "camp wipes", "towelettes"],
  towel: ["chamois", "pack towel", "microfibre towel", "microfiber towel", "camp towel", "travel towel", "quick dry towel", "quick-dry towel", "washcloth", "face cloth", "flannel", "hand towel", "shammy"],
  "pee cloth": ["pee rag", "antimicrobial pee cloth", "pee wipe", "kula cloth", "wee cloth", "pee towel"],
  "pee funnel": ["female urination device", "fud", "shewee", "she-wee", "stand to pee", "urination device", "pee device", "female urinal", "stand-to-pee"],
  bidet: ["portable bidet", "travel bidet", "backcountry bidet", "bum gun", "backpacking bidet", "bottle bidet", "hiking bidet"],
  trowel: ["cat hole trowel", "cathole trowel", "poop trowel", "potty trowel", "digging tool", "poop shovel", "toilet trowel", "sanitation trowel", "digger", "poo trowel", "hole digger", "spade", "poo spade", "toilet spade", "hiking spade"],
  shovel: ["snow shovel", "camp shovel", "spade", "folding shovel", "avalanche shovel"],
  "waste bags": ["wag bags", "wag bag", "poop bags", "toilet bags", "waste kit", "poo bags", "human waste bags", "pack out bags", "pack-out bags"],
  "waste tablets": ["waste treatment", "poop powder", "gelling powder", "waste gel"],
  "bathroom kit": ["toilet kit", "poop kit", "loo kit", "potty kit", "cathole kit", "sanitation kit", "backcountry toilet kit"],
  "toiletry bottle": ["travel bottle", "leak proof bottle", "leak-proof bottle", "squeeze tube", "travel tube", "silicone bottle", "gotoob"],
  "dropper bottle": ["eye dropper bottle", "mini dropper", "dropper", "dropper vial", "small dropper"],
  "spray bottle": ["mister", "spritzer", "mist bottle", "spray", "atomizer", "atomiser"],
  "pill bottle": ["pill container", "pill case", "medicine bottle", "pill organizer", "pill organiser", "pill box", "pill vial", "meds container"],
  hairbrush: ["hair brush", "comb", "travel brush", "mini hairbrush", "travel comb"],
  "nail clippers": ["nail clipper", "clippers", "nail cutter", "nail trimmer", "nail scissors"],
  "eye mask": ["sleep mask", "sleeping mask", "blindfold", "eyemask", "eye shade", "eye shades", "sleep shade"],
  "massage ball": ["lacrosse ball", "trigger point ball", "recovery ball", "foot roller", "muscle ball", "cork ball"],
  brush: ["cleaning brush", "dust brush", "tent brush", "camp brush", "whisk broom", "mini broom"],
  // — camp and misc —
  "camp chair": ["camp seat", "camping chair", "backpacking chair", "folding chair", "chair", "lightweight chair", "trail chair", "packable chair"],
  "camp stool": ["camping stool", "folding stool", "stool", "backpacking stool", "tripod stool", "seat"],
  "chair feet": ["chair ball feet", "ground feet", "chair ground sheet", "chair anchors"],
  table: ["camp table", "camping table", "folding table", "backpacking table", "trail table"],
  cooler: ["esky", "chilly bin", "cool box", "coolbox", "ice box", "icebox", "ice chest", "cooler box", "cooler bag"],
  meal: ["food pouch", "freeze dried meal", "freeze-dried meal", "dehydrated meal", "dehy", "dehy meal", "dehy food", "backpacking meal", "dinner", "ready meal", "camp meal", "camping meal", "backpacking food", "freeze dried food", "dehydrated food", "trail meal", "just add water", "meal pouch", "pouch meal", "camp food", "hiking food", "freeze dried", "dehydrated", "breakfast", "lunch", "ration pack", "rations", "rat pack", "boil in the bag"],
  "energy bar": ["snack bar", "cereal bar", "bar", "trail bar", "hiking bar", "energy bars", "food bar", "muesli bar", "flapjack", "oat bar"],
  "protein bar": ["bar", "protein snack", "recovery bar", "protein bars"],
  "granola bar": ["cereal bar", "muesli bar", "bar", "oat bar", "flapjack", "breakfast bar"],
  "energy chews": ["chews", "energy gummies", "gummies", "sport chews", "energy blocks", "energy jelly", "jelly babies"],
  "energy waffle": ["waffle", "stroopwafel", "stroopwafels", "energy waffles", "wafer"],
  "electrolyte mix": ["electrolytes", "hydration mix", "drink mix", "hydration tablets", "electrolyte tablets", "electrolyte powder", "salt tabs", "salt tablets", "hydration powder", "electrolyte drink", "sports drink", "isotonic", "rehydration", "hydration sachets", "electrolyte chews"],
  snack: ["snacks", "trail snack", "hiking snack", "biscuit", "biscuits", "cookie", "cookies", "pastry", "pastries", "treat", "treats"],
  "snack mix": ["trail mix", "gorp", "scroggin", "nut mix", "nuts", "mixed nuts", "dry fruits", "dry fruit", "party mix", "hiking mix"],
  "nut butter": ["peanut butter", "almond butter", "nut butter packet", "nut butter pouch", "butter packet"],
  "fruit snack": ["dried fruit", "dry fruits", "fruit leather", "fruit puree", "fruit pouch", "fruit strips", "fruit roll", "fruit bar"],
  "candy bar": ["chocolate bar", "chocolate", "candy", "sweets", "lollies", "choc bar", "chocolate snack"],
  "dog food": ["kibble", "dog kibble", "dehydrated dog food", "freeze dried dog food", "dog meal", "dog rations", "pet food"],
  "dog bowl": ["pet bowl", "collapsible bowl", "dog dish", "water bowl", "travel bowl"],
  leash: ["dog leash", "dog lead", "lead", "long line", "leash line"],
  "bear bell": ["bell", "trekking bell", "hiking bell", "bear bells", "trail bell"],
  "bear can key": ["canister key", "bear canister key", "canister opener", "bear vault key"],
  "stake bag": ["peg bag", "stake sack", "tent peg bag", "tent stake bag", "stake pouch"],
  "stake tool": ["peg puller", "stake puller", "peg tool", "stake remover"],
  "pole bag": ["pole sack", "tent pole bag", "pole sleeve", "pole case"],
  "pole holder": ["pole loop", "pole keeper", "pole attachment", "pole carry", "trekking pole holder", "pole clip"],
  "handle grips": ["pole grips", "grip covers", "handle covers", "grips"],
  "back pad": ["back panel", "lumbar pad", "frame pad", "backpad", "pack pad"],
  "shoulder pads": ["strap pads", "strap cushions", "shoulder cushions", "strap padding", "shoulder strap pads"],
  "pillow strap": ["pillow holder", "pillow keeper", "pillow band", "pillow attachment"],
  pillowcase: ["pillow case", "pillow cover", "pillow sleeve", "pillow slip"],
  "vestibule mat": ["porch mat", "tent mat", "door mat", "doormat", "entry mat"],
  "tent floor": ["bathtub floor", "tent bathtub", "floor", "inner floor"],
  ridgeline: ["ridge line", "hammock ridgeline", "structural ridgeline"],
  "ventilation frame": ["vent frame", "tent vent", "vent prop", "vent strut"],
  "egg holder": ["egg case", "egg carrier", "egg box", "egg container"],
  "one hitter": ["pipe", "one-hitter", "chillum", "bat"],
  pen: ["biro", "ballpoint", "ballpoint pen", "writing pen", "trail pen"],
  pencil: ["pencils", "mechanical pencil", "trail pencil"],
  notebook: ["notepad", "note pad", "journal", "field notebook", "waterproof notebook", "jotter", "paper", "diary", "notebooks"],
  "card game": ["playing cards", "cards", "deck of cards", "card deck", "game"],
  sticker: ["stickers", "decal", "decals"],
  "packraft": ["pack raft", "inflatable raft", "raft", "inflatable kayak", "packrafting"],
  paddle: ["kayak paddle", "packraft paddle", "canoe paddle", "oar"],
  saw: ["folding saw", "hand saw", "camp saw", "pocket saw", "wire saw", "pruning saw"],
  screwdriver: ["multi-tool", "multitool", "multi tool", "driver", "bit driver", "screw driver"],
  "rock sack": ["rock bag", "throw bag", "throw sack", "bear hang sack", "rock pouch"],
  "saddle bag": ["saddlebag", "saddle bags", "pannier", "panniers"],
  "sheath": ["knife sheath", "trowel sheath", "blade cover", "knife cover", "holster"],
  "lip guards": ["mug guards", "heat guards", "lip protectors", "cup guards", "rim guards"],
  "lid knob": ["lid handle", "pot knob", "lid grip", "knob"],
  spatula: ["turner", "fish slice", "flipper", "camp spatula", "cooking spatula"],
  tongs: ["camp tongs", "cooking tongs", "titanium tongs", "grill tongs"],
  "grill plate": ["grill", "grate", "camp grill", "cooking grate", "grill grate", "bbq plate", "griddle", "braai", "braai grid", "braai plate"],
  "coffee straw": ["brew straw", "coffee filter straw", "straw brewer"],
  "cleaning tablets": ["bladder cleaning tablets", "reservoir cleaning tablets", "cleaning tabs", "hydration cleaning tablets"],
  "wine bottle": ["wine flask", "wine carrier", "wine bag", "wine container"],
  "stove base": ["stove stand", "stove platform", "stove pad", "stove plate"],
  "canister tool": ["canister puncture tool", "can puncture tool", "crunchit", "canister recycling tool", "can crusher"],
  "mesh sleeve": ["mesh pocket", "mesh bag", "mesh sack", "mesh cover"],
};

// Fallback noun when a row's name carries no gear word (model-only names like
// "Copper Spur", "X-Mid", "Talon 22"). Deliberately conservative — only the
// categories where one noun overwhelmingly dominates the model-named survivors.
// Ambiguous buckets (sleep = bag/pad/quilt, cook = stove/pot/mug) are omitted and
// left to name derivation, so we never mislabel them.
const CATEGORY_DEFAULT_NOUN: Record<string, string> = {
  shelter: "tent",
  pack: "backpack",
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Nouns whose singular is a different word: "shorts" stripped to "short" fired on
// every "Short Sleeve" top in the catalog (21 rows, 2026-09-20). These match only
// as written. ("pants" stays strippable — makers write "G-Pant", "Fleece Pant".)
const NO_SINGULAR = new Set(["shorts"]);

// One precompiled matcher per pattern (nouns map to themselves; aliases map to
// their canon). Optional trailing "s" covers the plural-name / singular-canon
// direction and its inverse. Longest pattern wins across BOTH lists; a tie is
// broken alphabetically, so "Fleece Jacket" is a fleece whatever order the lists
// are written in (insertion order once decided eight names, silently).
const MATCHERS: ReadonlyArray<{ canon: string; re: RegExp }> = [
  ...NOUNS.map((n) => [n, n] as const),
  ...Object.entries(ALIASES),
]
  .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))
  .map(([pattern, canon]) => ({
    canon,
    re: NO_SINGULAR.has(pattern)
      ? new RegExp(`\\b${esc(pattern)}\\b`, "i")
      : new RegExp(`\\b${esc(pattern.endsWith("s") ? pattern.slice(0, -1) : pattern)}s?\\b`, "i"),
  }));

// Reverse index: canonical noun → the alias tokens that point at it. Built once so
// buildSearchTerms doesn't re-scan ALIASES per row.
const ALIASES_BY_CANON: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [alias, canon] of Object.entries(ALIASES)) (out[canon] ??= []).push(alias);
  return out;
})();

/** Whether `s` is a canon the vocabulary itself defines — a NOUN or an alias target.
 *  EXTRA_TERMS may also key a gear type; tests/catalog-data.test.ts checks those
 *  against the built catalog, so a misspelt key can't sit there matching nothing. */
export function isVocabularyCanon(s: string): boolean {
  return (NOUNS as readonly string[]).includes(s) || Object.values(ALIASES).includes(s);
}

/** The canonical noun a product name implies, or null when nothing matches. */
export function deriveNoun(productName: string): string | null {
  for (const { canon, re } of MATCHERS) if (re.test(productName)) return canon;
  return null;
}

/** A canon and everything a searcher might type for it: its matcher aliases and its
 *  search-only extras. The canon is a NOUN or a lowercased gear type; either can key
 *  EXTRA_TERMS, so the same words hang off "sleeping pad" whether a row reached it
 *  as a noun or as its type. A gear type that is itself an ALIAS key ("Hip pack",
 *  "Water reservoir", "Foam pad") follows the alias, so the six hip packs carry the
 *  fanny pack's words and not just their own name. */
function termsFor(canon: string): string[] {
  const own = [canon, ...(ALIASES_BY_CANON[canon] ?? []), ...(EXTRA_TERMS[canon] ?? [])];
  const target = ALIASES[canon];
  return target ? [...own, ...termsFor(target)] : own;
}

/** The gear type as a search canon: lowercased, single-spaced, or null when blank. */
function gearTypeCanon(commonName: string | null | undefined): string | null {
  const key = (commonName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return key || null;
}

/**
 * The space-joined extra search words for a catalog row: its canonical noun (from
 * the name, else a per-category default, else the noun its gear type implies) plus
 * every alias/locale variant for that noun, plus the gear type itself and ITS
 * variants. Returns null only when neither exists (a row with no gear type and a
 * name that carries no gear word stays name-searchable only). Stored in
 * catalog_items.search_terms and folded into the fuzzy match.
 *
 * `commonName` is the row's hand-authored gear type — literally "what this thing
 * is", so it's the most direct answer to "what noun would someone type". As a NOUN
 * source it still resolves LAST, behind the category default, on purpose: ahead of
 * it, every model-named shelter/pack row would swap the noun it already has for a
 * different one. But the type is always folded in as a term of its own (2026-09-20),
 * so a row is findable by what it is whatever noun it carries: a model-named tarp
 * keeps "tent" AND gains "tarp"; a GPS watch, a phone or a tube of sunscreen — types
 * the noun vocabulary never spelled — are found by their type and its regional
 * words. Strictly additive: no term a row had before is ever removed.
 */
export function buildSearchTerms(
  name: string,
  categoryHint: string | null,
  commonName?: string | null,
): string | null {
  const noun =
    deriveNoun(name) ??
    (categoryHint ? CATEGORY_DEFAULT_NOUN[categoryHint] : null) ??
    deriveNoun(commonName ?? "") ??
    null;
  const type = gearTypeCanon(commonName);
  const terms = new Set<string>();
  if (noun) {
    // The noun and its aliases always (this is what every row had before 2026-09-20).
    // Its search-only vocabulary only when the noun is what the row IS: a name word
    // that disagrees with the gear type is a model word, and the type carries its own.
    terms.add(noun);
    for (const t of ALIASES_BY_CANON[noun] ?? []) terms.add(t);
    const typeCanon = type ? (ALIASES[type] ?? type) : null;
    if (!typeCanon || typeCanon === noun) for (const t of EXTRA_TERMS[noun] ?? []) terms.add(t);
  }
  if (type) for (const t of termsFor(type)) terms.add(t);
  return terms.size ? [...terms].join(" ") : null;
}
