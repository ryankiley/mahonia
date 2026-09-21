import { describe, expect, it } from "vitest";
import { buildSearchTerms, deriveNoun } from "../scripts/searchTerms";

describe("deriveNoun", () => {
  it("reads a gear noun straight out of the name", () => {
    expect(deriveNoun("Nemo Tensor Sleeping Pad")).toBe("sleeping pad");
    expect(deriveNoun("MSR PocketRocket Stove")).toBe("stove");
  });

  it("prefers the longest matching noun", () => {
    expect(deriveNoun("Sea to Summit Sleeping Bag Liner")).toBe("sleeping bag liner");
  });

  it("resolves a locale/synonym alias to its canonical noun", () => {
    expect(deriveNoun("Osprey Rucksack 40")).toBe("backpack");
    expect(deriveNoun("Petzl Head Torch")).toBe("headlamp");
  });

  it("breaks a tie between equal-length patterns alphabetically, not by list order", () => {
    // "Fleece Jacket" matches "fleece", "jacket" (and "Fleece Hoodie" matches "hoodie")
    // at the same length; insertion order once decided these, silently.
    expect(deriveNoun("Mountain Hardwear Loam Fleece Jacket")).toBe("fleece");
    expect(deriveNoun("All-Paca Fleece Hoodie")).toBe("fleece");
  });

  it("keeps a plural-only noun plural: 'shorts' never matches 'Short Sleeve'", () => {
    expect(deriveNoun("Mountain Hardwear Canyon Short Sleeve")).toBeNull();
    expect(deriveNoun("BRANWYN Compressive Short")).toBeNull();
    expect(deriveNoun("XOSKIN Liner Shorts")).toBe("shorts");
    // …while the ordinary strip still reads a maker's singular
    expect(deriveNoun("Patagonia Terrebonne Pant")).toBe("pants");
  });

  it("reads a model word as a model word: torch, mat and puffy are search-only", () => {
    // Soto's Pocket Torch is a lighter, HikeLight's Vestibule Mat is not a sleeping
    // pad, and a Synthetic Puffy would not be down — none of them relabels a row.
    expect(deriveNoun("Soto Pocket Torch XT")).toBeNull();
    expect(buildSearchTerms("Soto Pocket Torch XT", "cook", "Lighter")).toMatch(/^lighter\b/);
    expect(buildSearchTerms("Soto Pocket Torch XT", "cook", "Lighter")).not.toContain("flashlight");
    expect(deriveNoun("Some Maker Camp Mat")).toBeNull();
    expect(deriveNoun("Some Maker Synthetic Puffy")).toBeNull();
    // …but typing them still finds the rows they belong to.
    expect(buildSearchTerms("Fenix E12", "electronics", "Flashlight")).toContain("torch");
    expect(buildSearchTerms("Tensor", "sleep", "Sleeping pad")).toContain("mat");
    expect(buildSearchTerms("Cerium Hoody", "clothing", "Down jacket")).toContain("puffy");
  });

  it("only matches on word boundaries (no false 'tent' in 'Tentacle')", () => {
    expect(deriveNoun("Tentacle Gear Widget")).toBeNull();
    expect(deriveNoun("Backpacking Kit")).toBeNull(); // 'backpack' needs a boundary
  });

  it("returns null when the name carries no gear word", () => {
    expect(deriveNoun("Big Agnes Copper Spur HV UL2")).toBeNull();
    expect(deriveNoun("Durston X-Mid 2")).toBeNull();
  });
});

describe("buildSearchTerms", () => {
  it("falls back to a category default for a model-only name", () => {
    // The marquee case: model-named tents become findable by "tent".
    expect(buildSearchTerms("Copper Spur HV UL2", "shelter")).toMatch(/^tent\b/);
    expect(buildSearchTerms("Osprey Exos 58", "pack")).toMatch(/^backpack rucksack\b/);
  });

  it("prefers the name-derived noun over the category default", () => {
    // A tarp in the shelter category must stay 'tarp', not become 'tent'.
    expect(buildSearchTerms("Hyperlite Flat Tarp", "shelter")).toMatch(/^tarp\b/);
    expect(buildSearchTerms("Zpacks Bivy", "shelter")).toMatch(/^bivy\b/);
  });

  it("folds every alias for the noun into the terms", () => {
    const terms = buildSearchTerms("Nemo Tensor Sleeping Pad", "sleep");
    expect(terms).toContain("sleeping pad");
    expect(terms).toContain("mattress"); // UK/colloquial term matches the same row
    // "battery" reaches a power bank the way "puffy" reaches a down jacket
    expect(buildSearchTerms("Anker MagGo Power Bank", "other")).toContain("battery");
  });

  it("returns null for an ambiguous category with no name noun", () => {
    // 'sleep' has no default (bag vs pad vs quilt) — don't guess.
    expect(buildSearchTerms("Katabatic Flex", "sleep")).toBeNull();
    expect(buildSearchTerms("Some Widget", "other")).toBeNull();
    expect(buildSearchTerms("Some Widget", null)).toBeNull();
  });

  it("falls back to the row's gear type when nothing else resolves", () => {
    // The ambiguous categories the default skips: the row's own "what it is" label
    // answers what the name couldn't, so a model-named quilt is findable by "quilt".
    expect(buildSearchTerms("Katabatic Flex", "sleep", "Quilt")).toMatch(/^quilt\b/);
    expect(buildSearchTerms("Katabatic Flex", "sleep", "Sleeping pad")).toContain("mattress");
    expect(buildSearchTerms("Some Widget", null, "Water filter")).toMatch(/^water filter\b/);
  });

  it("keeps the gear type BEHIND the category default as the NOUN, but always folds it in", () => {
    // A model-named shelter row resolves to 'tent'; consulting its gear type first would
    // swap the noun rows already have. The type is added as a term of its own instead, so
    // the model-named tarp keeps 'tent' AND is findable by 'tarp'.
    const xmid = buildSearchTerms("Durston X-Mid 2", "shelter", "Tarp")!;
    expect(xmid).toMatch(/^tent\b/);
    expect(xmid.split(" ")).toContain("tarp");
    // …and the name stays the strongest signal for the noun.
    expect(buildSearchTerms("Hyperlite Flat Tarp", "shelter", "Tent")).toMatch(/^tarp\b/);
  });

  it("finds the audio rows by what they are, not only by their model name", () => {
    // AirPods, Powerbeats and the like are named for the model, never for the noun, and
    // electronics has no category default, so the gear type is the only way "earbuds"
    // or "headphones" can reach them.
    const buds = buildSearchTerms("AirPods Pro 3", "electronics", "Earbuds")!;
    expect(buds).toMatch(/^earbuds\b/);
    expect(buds).toContain("earphones");
    expect(buildSearchTerms("Powerbeats Pro 2", "electronics", "Earbuds")).toContain("earbuds");
    const cans = buildSearchTerms("AirPods Max 2", "electronics", "Headphones")!;
    expect(cans).toMatch(/^headphones\b/);
    expect(cans).toContain("headset");
  });

  it("makes every row findable by its gear type, even one the noun vocabulary never spelled", () => {
    // Before 2026-09-20 a fifth of the catalog resolved to no term at all: the noun list
    // is ~100 words, the hand-authored gear types ~350. The type is the term now.
    expect(buildSearchTerms("Some Widget", null, "Doohickey")).toBe("doohickey");
    expect(buildSearchTerms("Fenix 8", "electronics", "GPS watch")).toMatch(/^gps watch\b/);
    expect(buildSearchTerms("Aloe Kote SPF 25", "consumable", "Sunscreen")).toContain("sunblock");
    // …but a blank type on a model-only name still yields nothing to search by.
    expect(buildSearchTerms("Some Widget", null, "")).toBeNull();
    expect(buildSearchTerms("Some Widget", null, null)).toBeNull();
  });

  it("hangs the regional words off the type as well as the noun", () => {
    // UK, AU/NZ and CA hikers type different words for the same thing; each list is
    // search-only, so a maker's model word ("Windshield" sunglasses) can't mislabel a row.
    const runners = buildSearchTerms("Lone Peak 9", "clothing", "Trail runners")!;
    for (const t of ["trail runners", "trainers", "trail running shoes", "runners"]) expect(runners).toContain(t);
    const gps = buildSearchTerms("eTrex 22x", "electronics", "GPS handheld")!;
    for (const t of ["gps handheld", "gps", "satnav"]) expect(gps.split(" ").join(" ")).toContain(t);
    const vest = buildSearchTerms("ADV Skin 12", "pack", "Running vest")!;
    expect(vest).toMatch(/^backpack\b/); // the pack default is still the noun…
    for (const t of ["running vest", "hydration vest", "race vest"]) expect(vest).toContain(t); // …and the type reaches it
    expect(buildSearchTerms("Tensor", "sleep", "Sleeping pad")).toContain("air mat");
    expect(buildSearchTerms("Chair Zero", "other", "Camp chair")).toContain("camping chair");
  });

  it("attaches a name-noun's vocabulary only when the noun is what the row is", () => {
    // "Pot Cozy" reads as a pot and "Compression Cap" as a cap; the noun and its
    // aliases still attach (they always did) but the pot's saucepan / billy and the
    // cap's ball cap / snapback do not — the gear type carries the row's own words.
    const cozy = buildSearchTerms("Toaks Pot Cozy", "cook", "Pot cozy")!;
    expect(cozy.split(" ")).toContain("pot");
    expect(cozy).toContain("pot cosy");
    expect(cozy).not.toContain("saucepan");
    const cap = buildSearchTerms("Zenbivy Compression Cap", "other", "Compression straps")!;
    expect(cap.split(" ")).toContain("cap");
    expect(cap).not.toContain("snapback");
    expect(buildSearchTerms("Oakley Eye Jacket", "clothing", "Sunglasses")).not.toContain("coat");
    expect(buildSearchTerms("Oakley Eye Jacket", "clothing", "Sunglasses")).toContain("sunnies");
    // …and attaches in full when they agree, through an alias too.
    expect(buildSearchTerms("Nemo Tensor Sleeping Pad", "sleep", "Sleeping pad")).toContain("self inflating mat");
    expect(buildSearchTerms("CamelBak Crux Reservoir", "water", "Water reservoir")).toContain("hydration bladder");
  });

  it("follows an alias when the gear type is itself one, so the type's rows get its words", () => {
    // Six rows are typed "Hip pack"; three of them (a hyphenated Hip-Pack, two
    // Lumbarpacks) carry no fanny-pack word in the name and sit under the pack
    // default, so before this the whole type answered only to "hip pack".
    const hip = buildSearchTerms("WEBO Gear Thru Hip-Pack", "pack", "Hip pack")!;
    for (const t of ["hip pack", "fanny pack", "bum bag", "waist pack", "rucksack"]) expect(hip).toContain(t);
    expect(buildSearchTerms("CNOC Vecto Water Container", "water", "Water reservoir")).toContain("camelback");
    expect(buildSearchTerms("Thinlight Foam Pad", "sleep", "Foam pad")).toContain("mattress");
  });

  it("folds a duplicate noun into the one the catalog's gear type uses", () => {
    // 'footprint' and 'groundsheet' were two nouns for one thing, so "groundsheet" never
    // found a Big Agnes footprint; 'hip pack' and 'fanny pack' likewise; 'buff' (the brand
    // that became the word) was a noun that matched nothing and left neck gaiters on the
    // LEG-gaiter noun.
    expect(deriveNoun("Tiger Wall UL2 Footprint")).toBe("groundsheet");
    expect(buildSearchTerms("Tiger Wall UL2 Footprint", "shelter", "Groundsheet")).toContain("footprint");
    expect(deriveNoun("Gnuhr Footprint Camp Sandal")).toBe("sandals"); // the one "Footprint" that is not
    expect(deriveNoun("Freerain Packable Hip Pack")).toBe("fanny pack");
    expect(buildSearchTerms("Freerain Packable Hip Pack", "pack", "Hip pack")).toContain("bum bag");
    expect(deriveNoun("Zpacks Neck Gaiter")).toBe("neck gaiter");
    const neck = buildSearchTerms("CoolNet UV Multifunctional Neckwear", "clothing", "Neck gaiter")!;
    expect(neck).not.toMatch(/^gaiters\b/);
    for (const t of ["buff", "snood", "neck tube"]) expect(neck).toContain(t);
  });

  it("never reads a search-only word out of a product name", () => {
    // "Hoody" is Arc'teryx's word for a down jacket as much as for a hoodie; "Windshield"
    // is a pair of sunglasses; "Cutlery Spoon" is a spoon. Typing them still finds the
    // rows whose TYPE they belong to, but a name can't be relabelled by one.
    expect(deriveNoun("Cerium Hoody")).toBeNull();
    expect(deriveNoun("Windshield")).toBeNull();
    expect(deriveNoun("Alpha Light Cutlery Spoon")).toBe("spoon");
    expect(buildSearchTerms("Cerium Hoody", "clothing", "Down jacket")).toMatch(/^down jacket\b/);
    expect(buildSearchTerms("R1 Air Hoody", "clothing", "Hoodie")).toContain("hoody");
  });

  it("keeps the words that hurt a common query off the rows they do not name", () => {
    // Review of 2026-09-20: "watch cap" put 22 beanies at parity with 96 watches for
    // "watch"; "pants" on underwear put boxer briefs beside hiking pants for a US
    // user; "hammock quilt" put 108 quilts into "hammock"; a brand with its own rows
    // is never a generic word (the ranker caps a kind-of-gear query at two per brand).
    expect(buildSearchTerms("Zpacks Beanie", "clothing", "Beanie")!.split(" ")).not.toContain("watch");
    expect(buildSearchTerms("Give-N-Go Boxer Brief", "clothing", "Underwear")!.split(" ")).not.toContain("pants");
    expect(buildSearchTerms("Katabatic Flex", "sleep", "Quilt")!.split(" ")).not.toContain("hammock");
    expect(buildSearchTerms("Some Maker Trowel", "other", "Trowel")).not.toContain("deuce");
    expect(buildSearchTerms("Some Maker Mini Lighter", "cook", "Lighter")!.split(" ")).not.toContain("bic");
  });
});
