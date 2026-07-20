// The gear-type common-name vocabulary — the loose-canonical set of "what it is" labels
// (tent, trail runners, trekking poles) shown as the quiet sub-line under a product name.
// A label is generated per catalog row (seed/common-names.json), then normalized HERE so
// near-duplicates collapse to one term and the vocabulary stays consistent as rows are added.
//
// Aligned to the search spine (shared/searchTerms.ts NOUNS) where the concepts overlap, so
// search and display share spellings — but the better DISPLAY term wins when a search noun
// reads worse ("neck gaiter", not "buff"); search matches via a row's search_terms, never
// its common name, so the two need only be consistent, not identical.
//
// BUILD-TIME ONLY, which is why this lives in scripts/ beside catalogChecks + catalogCsv
// rather than in shared/: the one production caller is build-catalog.ts (the tests import
// it too). A gear type the USER types is deliberately left alone — canonicalizing someone's
// own label for their own list would be us overruling them, and the vocabulary exists to
// keep the CATALOG's generated defaults consistent, not to police what people write.

/**
 * Drift map: a raw/legacy label → its canonical common name. Only entries that CHANGE live
 * here (singular/plural, spelling variants, and clear same-object synonyms) — a label absent
 * from the map is already canonical. Genuinely distinct types are deliberately NOT merged
 * (down jacket ≠ synthetic jacket ≠ fleece; tent ≠ tarp ≠ bivy; water filter ≠ water treatment).
 */
export const GEAR_TYPE_ALIASES: Record<string, string> = {
  "bottle holster": "bottle holder",
  "bottle lid": "bottle cap",
  bottles: "water bottle",
  bra: "sports bra",
  "camp towel": "towel",
  "cord spool": "cord reel",
  "cord winder": "cord reel",
  "cutlery set": "utensils",
  "ditty bag": "stuff sack",
  "down booties": "booties",
  "guyline tensioners": "line tensioner",
  "hip belt pouch": "hip belt pocket",
  "hipbelt pocket": "hip belt pocket",
  "hydration system": "hydration pack",
  "liner gloves": "glove liners",
  "lumbar pack": "hip pack",
  "mess kit": "cookset",
  "packing cube": "packing cubes",
  "running shoes": "trail runners",
  "satellite communicator": "satellite messenger",
  "shell jacket": "rain jacket",
  "shoulder pouch": "shoulder pocket",
  "shoulder strap": "shoulder straps",
  "shoulder strap pocket": "shoulder pocket",
  "snack bag": "snack pouch",
  "stake pusher": "stake tool",
  "stake sack": "stake bag",
  "stash bag": "stuff sack",
  "sun sleeves": "arm sleeves",
  "tent pole": "tent poles",
  "tent stake": "tent stakes",
  "torch lighter": "lighter",
  "traction spikes": "microspikes",
  utensil: "utensils",
  "water purifier": "water filter",
  "water tablets": "water treatment",
  windbreaker: "wind jacket",
  "zipper pouch": "pouch",
};

// leading words that read better fully upper-cased than sentence-cased ("GPS watch", "PLB").
// A Set, not a map of word→GPS: every value would just be the word upper-cased, so a map
// implied a per-word override the vocabulary has never needed.
const ACRONYMS = new Set(["gps", "plb"]);

/** Sentence-case: capitalize the FIRST word only ("trail runners" → "Trail runners"),
 *  upper-casing a known leading acronym whole ("gps watch" → "GPS watch"). */
function sentenceCase(s: string): string {
  if (!s) return s;
  const sp = s.indexOf(" ");
  const first = sp === -1 ? s : s.slice(0, sp);
  const rest = sp === -1 ? "" : s.slice(sp);
  return (ACRONYMS.has(first) ? first.toUpperCase() : first.charAt(0).toUpperCase() + first.slice(1)) + rest;
}

/** Canonicalize a common-name label: lowercase + trim, apply the drift map, then
 *  sentence-case it (first word capitalized) — the default display form. */
export function normalizeGearType(label: string | null | undefined): string {
  const key = (label ?? "").trim().toLowerCase();
  if (!key) return "";
  return sentenceCase(GEAR_TYPE_ALIASES[key] ?? key);
}
