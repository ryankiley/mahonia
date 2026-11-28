// Pure catalog data-quality helpers shared by the build pipeline, the runtime
// server (community intake), and tests. No DB, no node-only deps.

import { foldForSearch } from "./searchText";
import { MG_PER_UNIT } from "./weights";

// Plausible weight range per category, grams. Loose — catches gross slips
// (a 50 g tent, a 5 kg stove), not borderline judgment calls. (Relocated here from
// scripts/catalogChecks when server intake could not import scripts/. The server does
// now, for verify_catalog_item's house rules, but this file is where intake, the
// connector and the checks all read the bands.)
export const RANGE_G: Record<string, [number, number]> = {
  shelter: [120, 3500],
  sleep: [40, 2600],
  pack: [120, 2800],
  cook: [8, 1300],
  water: [10, 800],
  clothing: [10, 1200],
  electronics: [4, 700],
  firstaid: [3, 600],
  consumable: [0.3, 1600], // purification tablets are legitimately sub-gram
  other: [4, 1600],
};
/** The catalog's categories. The order is the CSV's sort order (scripts/catalogBuild.ts)
 *  and the order verify_catalog_item's schema lists them in. */
export const CATALOG_CATEGORIES = Object.keys(RANGE_G);

// --- citations and ownership (the audit, the seed, verify_catalog_item) ----

/** After a unit: a rate or a weight per area, never what the thing weighs. A fabric's
 *  "36 g/m²" or "1.0 oz/yd²", a stove's "12 g/hr", a "per square metre" figure. A slash
 *  before a number stays a weight: "539 g / 19 oz" is one weight in two units. */
const NOT_A_RATE = String.raw`(?!\s*\/\s*[a-z²]|\s*per\s+(?:sq|square|m\b|metre|meter|yd|yard|ft|foot|hour|hr|day|litre|liter|l\b))`;

/** A weight a quote states, in grams: one figure (lo === hi), or a range ("36 to 39 oz"),
 *  which backs either end and anything between. */
export type QuoteWeight = { lo: number; hi: number };

const OZ_G = MG_PER_UNIT.oz / MG_PER_UNIT.g;
const LB_G = MG_PER_UNIT.lb / MG_PER_UNIT.g;
/** A metric figure: thousands separators read whole ("1,790 g" is 1790, not 790), and a
 *  decimal comma's last digits never read alone ("1,2 kg" isn't 2 kg). */
const METRIC_FIG = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
/** An imperial figure: "19", "2.1", or ".60" whole, never the "60" of ".60" (which read
 *  as 60 oz, 1.7 kg, and backed a weight the quote doesn't state). */
const IMPERIAL_FIG = String.raw`\d*\.\d+|\d+`;
/** What may join the figures before one unit: ", " (a list), an unspaced "/" (a list,
 *  "13/19 oz"), an unspaced hyphen or dash or a " to " (a range, "36-39 oz"). Spaced
 *  slashes and dashes are left out: "Flash 22 / 10.6 oz" is a model and a weight. */
const JOIN = String.raw`,\s+|\/|[-–—]|\s+to\s+`;

/** The figures before each `unit` in `q`, a list or range read whole. A comma list
 *  counts only from three figures up, so "Size 10, 11.5 oz" is one weight; a range only
 *  when it rises; a list glued to a word ("SP129/85 g") only by its last figure. */
function figuresBefore(q: string, fig: string, unit: string, start: string): QuoteWeight[][] {
  const out: QuoteWeight[][] = [];
  const re = new RegExp(`${start}((?:${fig})(?:(?:${JOIN})(?:${fig}))*)\\s*${unit}${NOT_A_RATE}`, "gi");
  for (const m of q.matchAll(re)) {
    const run = m[1]!;
    const nums = [...run.matchAll(new RegExp(fig, "g"))].map((n) => parseFloat(n[0].replace(/,/g, "")));
    const joins = run.split(new RegExp(fig)).slice(1, -1);
    const last = nums.at(-1)!;
    const glued = /[a-z\d]/i.test(q[m.index! - 1] ?? "");
    const isRange = nums.length === 2 && /^(?:[-–—]|\s+to\s+)$/.test(joins[0]!) && nums[0]! < last;
    const isList = joins.length > 0 && !glued && (joins.every((j) => j === "/") || (nums.length >= 3 && joins.every((j) => /^,\s+$/.test(j))));
    if (isRange && !glued) out.push([{ lo: nums[0]!, hi: last }]);
    else if (isList) out.push(nums.map((n) => ({ lo: n, hi: n })));
    else out.push([{ lo: last, hi: last }]);
  }
  return out;
}

const scale = (ws: QuoteWeight[][], k: number) => ws.flat().map(({ lo, hi }) => ({ lo: lo * k, hi: hi * k }));

/** Every weight a quote states, in grams: metric figures, kilograms and grams spelled
 *  out or not, and imperial ones, "1 lb 3 oz" read as one figure and a lone "19 oz" or
 *  "2.1 lbs" as their own. A list before one unit ("8.3, 8.8, 9.3 oz", "368/538 Grams")
 *  is every figure in it, and a range ("36 to 39 oz") is one weight from end to end.
 *  The one reader for every research file and for verify_catalog_item: a US maker's
 *  page often gives ounces alone. */
export function quoteWeights(q: string): QuoteWeight[] {
  const metricStart = String.raw`(?<![\d.,])`;
  const out = [
    ...scale(figuresBefore(q, METRIC_FIG, String.raw`(?:kg|kilo(?:gram)?s?(?![a-z]))`, metricStart), 1000),
    ...scale(figuresBefore(q, METRIC_FIG, String.raw`g(?:rams?|r)?(?![a-z])`, metricStart), 1),
  ];
  const num = String.raw`(?<![\d.])(${IMPERIAL_FIG})`;
  const rest = q.replace(new RegExp(`${num}\\s*(?:lbs?|pounds?)\\.?,?\\s*${num}\\s*(?:oz|ounces?)\\b`, "gi"), (_, lb: string, oz: string) => {
    const g = parseFloat(lb) * LB_G + parseFloat(oz) * OZ_G;
    out.push({ lo: g, hi: g });
    return " ";
  });
  const imperialStart = String.raw`(?<![\d.])`;
  out.push(...scale(figuresBefore(rest, IMPERIAL_FIG, String.raw`(?:oz|ounces?)\b`, imperialStart), OZ_G));
  out.push(...scale(figuresBefore(rest, IMPERIAL_FIG, String.raw`(?:lbs?|pounds?)\b`, imperialStart), LB_G));
  return out;
}

/** Every figure a quote states, in grams: each weight quoteWeights reads, a range by its
 *  two ends. */
export const weightsInQuote = (q: string): number[] =>
  quoteWeights(q).flatMap(({ lo, hi }) => (lo === hi ? [lo] : [lo, hi]));

/** How far a quoted figure may sit from the weight it backs: 8 g or 5%, whichever is
 *  more. The research audit's tolerance, so a rounded ounce figure still agrees. */
const quoteTolerance = (grams: number) => Math.max(8, 0.05 * grams);

/** The quoted figure closest to `grams` (a range's nearest point, `grams` itself when it
 *  falls inside one), or null when the quote states no weight. */
export function nearestQuoteFigure(quote: string, grams: number): number | null {
  let nearest: number | null = null;
  for (const { lo, hi } of quoteWeights(quote)) {
    const at = Math.min(hi, Math.max(lo, grams));
    if (nearest == null || Math.abs(at - grams) < Math.abs(nearest - grams)) nearest = at;
  }
  return nearest;
}

/** Whether a quote states this weight: some figure in it within quoteTolerance. */
export const quoteBacksWeight = (quote: string, grams: number) =>
  quoteWeights(quote).some(({ lo, hi }) => {
    const at = Math.min(hi, Math.max(lo, grams));
    return Math.abs(at - grams) <= quoteTolerance(at);
  });

/** A row the seed owns: verified, and not by an admin in the app. Only these may be
 *  renamed or retired for the CSV not naming them; a community row and an in-app
 *  verified one (verified_by set) belong to the database. */
export const seedManaged = (r: { verified: boolean; verifiedBy: number | null }) => r.verified && r.verifiedBy == null;

// --- community intake (Phase 3) -------------------------------------------

/** Normalize a string to a comparison key — the ONE search fold (shared/searchText),
 *  so a candidate's identity can't disagree with the gear it was typed as: this used
 *  to be its own a–z fold, which keyed a name in Chinese as "" and so never let it
 *  become a candidate however many lists carried it. */
export function normKey(s: string | null | undefined): string {
  return foldForSearch(s ?? "");
}

/** A citation quote as the page reads it: one line, single spaces. A non-breaking,
 *  thin or zero-width space copied off a page is a space (or nothing), and a run of
 *  whitespace, line breaks included, is one space. The words themselves never change. */
export function tidyQuote(s: string): string {
  return s.replace(/[    ]/g, " ").replace(/[​﻿]/g, "").replace(/\s+/g, " ").trim();
}

/** A variant is redundant when its tokens already appear (contiguously) in the
 *  name — e.g. name "Copper Spur HV UL3" + variant "UL3" → renders "…UL3 · UL3".
 *  Such variants should be cleared (the name already carries the size/config). */
export function isVariantRedundant(name: string, variant: string | null | undefined): boolean {
  // Fold possessives before tokenizing: normKey would split "Women's" into "women s",
  // and a letter size "S" would then read as already-in-the-name.
  const fold = (s: string | null | undefined) => normKey((s ?? "").replace(/'/g, ""));
  const v = fold(variant);
  // the fold leaves words single-spaced, so a run of whole words is a padded substring
  return v !== "" && ` ${fold(name)} `.includes(` ${v} `);
}

/** Median of a numeric list (avg of the two middles for even length). */
export function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Best-effort list classification → catalog category_hint (lossy). */
export function classificationToCategory(c: string | null | undefined): string {
  if (c === "worn") return "clothing";
  if (c === "consumable") return "consumable";
  return "other"; // base / null → widest plausibility band
}

// The typed gear type, read for a plausibility band. A base row's class says nothing
// about what it is, and "other" tops out at 1.6 kg, so a corroborated 1.7 kg tent or
// pack typed by hand was rejected for good; "Tent" in the gear type field says which
// band applies. The verified catalog answers first, for a label it carries (catalogCategories):
// this table guesses by a word, and guessed wrong for dozens of the catalog's own gear types
// ("Dry bag" isn't sleep, "Sunglasses" aren't clothing), after which the catalog audit
// refused the row as filed apart from its siblings. The table is for a label no verified
// row has yet ("pack", "Frame pack"): matched on the whole phrase, then the last word
// ("Trail runners", "Rain jacket", "Cook pot"), lowercased; anything unrecognised falls
// back to the class.
const GEAR_TYPE_CATEGORY: Record<string, string> = {
  tent: "shelter", tarp: "shelter", shelter: "shelter", bivy: "shelter", footprint: "shelter", groundsheet: "shelter", hammock: "shelter",
  quilt: "sleep", bag: "sleep", pad: "sleep", mattress: "sleep", pillow: "sleep", liner: "sleep",
  pack: "pack", backpack: "pack", daypack: "pack",
  stove: "cook", pot: "cook", pan: "cook", mug: "cook", cup: "cook", bowl: "cook", spoon: "cook", spork: "cook", cookset: "cook", windscreen: "cook", lighter: "cook",
  bottle: "water", flask: "water", reservoir: "water", bladder: "water", filter: "water", purifier: "water",
  jacket: "clothing", shirt: "clothing", tee: "clothing", shorts: "clothing", pants: "clothing", fleece: "clothing", hoodie: "clothing", puffy: "clothing",
  gloves: "clothing", mittens: "clothing", hat: "clothing", beanie: "clothing", cap: "clothing", buff: "clothing", gaiters: "clothing", socks: "clothing",
  shoes: "clothing", boots: "clothing", sandals: "clothing", runners: "clothing", baselayer: "clothing", underwear: "clothing", sunglasses: "clothing",
  headlamp: "electronics", battery: "electronics", "power bank": "electronics", charger: "electronics", cable: "electronics", phone: "electronics", watch: "electronics", gps: "electronics", camera: "electronics",
  "first aid kit": "firstaid", "first aid": "firstaid",
  food: "consumable", fuel: "consumable", canister: "consumable", snack: "consumable", meal: "consumable", tablets: "consumable",
};
export function categoryForGearType(commonName: string | null | undefined, catalog?: ReadonlyMap<string, string>): string | null {
  const phrase = normKey(commonName);
  if (!phrase) return null;
  const filed = catalog?.get(phrase);
  if (filed) return filed;
  const last = phrase.split(" ").pop()!;
  return GEAR_TYPE_CATEGORY[phrase] ?? GEAR_TYPE_CATEGORY[last] ?? null;
}

/** Where the verified catalog files each gear type it carries, keyed by the search fold
 *  (normKey) categoryForGearType reads a label through. A gear type filed two ways goes
 *  where most of its rows are, a tie to the first category alphabetically, so the answer
 *  never hangs on the order rows come back in. A row with no category counts as "other",
 *  as the audit counts it. Pass verified rows only: a community row's category was typed. */
export function catalogCategories(rows: readonly { commonName: string | null; categoryHint: string | null }[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = normKey(r.commonName);
    if (!key) continue;
    const m = counts.get(key) ?? counts.set(key, new Map()).get(key)!;
    const category = r.categoryHint ?? "other";
    m.set(category, (m.get(category) ?? 0) + 1);
  }
  return new Map(
    [...counts].map(([key, m]) => [key, [...m].sort(([a, na], [b, nb]) => nb - na || (a < b ? -1 : a > b ? 1 : 0))[0]![0]]),
  );
}

// Generic gear nouns that are NOT branded products — a bare one of these (even
// corroborated) must never become a catalog row ("tent", "snacks", "water bottle").
export const GENERIC_GEAR_TERMS = new Set<string>([
  "tent", "tents", "tarp", "tarps", "shelter", "bivy", "footprint", "groundsheet",
  "pack", "backpack", "daypack", "bag", "dry bag", "stuff sack", "fanny pack", "hip pack",
  "quilt", "sleeping bag", "sleeping pad", "pad", "pillow", "liner",
  "stove", "pot", "pan", "mug", "cup", "bowl", "spoon", "spork", "fork", "knife", "cookset",
  "bottle", "water", "water bottle", "flask", "reservoir", "bladder", "filter", "purifier",
  "snack", "snacks", "food", "bar", "fuel", "gas", "canister", "tablets",
  "socks", "sock", "shirt", "tee", "shorts", "pants", "jacket", "rain jacket", "fleece",
  "hoodie", "puffy", "gloves", "mittens", "hat", "beanie", "cap", "buff", "gaiters",
  "shoes", "boots", "sandals", "trail runners", "sunglasses", "sunscreen", "lip balm",
  "towel", "umbrella", "trekking poles", "poles", "headlamp", "battery", "power bank",
  "charger", "cable", "first aid kit", "kit", "watch", "phone", "knife", "multitool",
]);

/** The part of the body a garment noun is worn on. The duplicate test drops generic
 *  nouns from a name before it compares, which threw away the one word telling
 *  "UL Mittens" from "UL Shirt" and "EX Light Down Pants" from "EX Light Down Jacket";
 *  two names whose garments sit on different parts of the body are two products. Left
 *  out on purpose: fleece and puffy (materials, as in "fleece pants"), buff, hood, top
 *  and crew, which are ambiguous or turn up on more than one part. A Map, not an
 *  object, so a typed word like "constructor" can't land on a prototype key. */
export const GARMENT_ZONE: ReadonlyMap<string, string> = new Map(
  Object.entries({
    torso: ["shirt", "tee", "jacket", "hoodie", "hoody", "parka", "vest", "smock", "anorak", "pullover"],
    legs: ["pants", "pant", "shorts", "tights", "leggings", "trousers"],
    hands: ["gloves", "glove", "mittens", "mitten", "mitts"],
    feet: ["socks", "sock", "shoes", "shoe", "boots", "boot", "sandals"],
    head: ["hat", "beanie", "cap"],
  }).flatMap(([zone, words]) => words.map((w) => [w, zone] as const)),
);

const PROFANITY = /\b(fuck|shit|bitch|cunt|asshole|nigg|faggot|retard)\b/i;
const PII =
  /(\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b|@[a-z0-9.-]+\.[a-z]{2,}|https?:\/\/|\b\d{7,}\b)/i;

/** Is a typed item name clean enough to consider for the catalog (no PII/junk)? */
export function isAcceptableTypedItem(p: { brand?: string | null; name: string }): boolean {
  const full = [p.brand, p.name].filter(Boolean).join(" ").trim();
  if (full.length < 2 || full.length > 120) return false;
  if (!/[a-z]/i.test(full)) return false; // must have a letter
  if (PROFANITY.test(full) || PII.test(full)) return false;
  return true;
}

const tokens = (s: string) => normKey(s).split(" ").filter(Boolean);

/**
 * A uniquely identifying first word of a multi-word catalog brand. This accepts
 * "Katabatic" for "Katabatic Gear", but not "Big" when both Big Agnes and Big Sky
 * exist. Generic gear nouns can never become a brand shorthand.
 */
function uniqueKnownBrandForFirstWord(
  firstWord: string | undefined,
  knownBrands: Iterable<string>,
): string | undefined {
  if (!firstWord || firstWord.length < 3 || GENERIC_GEAR_TERMS.has(firstWord)) return undefined;
  let match: string | undefined;
  for (const brand of knownBrands) {
    const words = tokens(brand);
    if (words.length < 2 || words[0] !== firstWord) continue;
    if (match) return undefined;
    match = brand;
  }
  return match;
}

/** A plausible new maker token at the front of a typed product name. */
function emergingBrandToken(name: string): string | undefined {
  const first = tokens(name)[0];
  return first && first.length >= 4 && !GENERIC_GEAR_TERMS.has(first) && !/^\d/.test(first)
    ? first
    : undefined;
}

/**
 * Brand tokens corroborated across distinct open candidates. Each candidate supplied
 * here already has two independent lists behind it; `normKey` must identify a product
 * rather than a variant, so Long and Regular do not teach the catalog a maker alone.
 * Requiring two product names prevents one typo or one model family from doing so.
 */
export function emergingBrandTokens(
  candidates: readonly { normKey: string; name: string }[],
): Set<string> {
  const candidatesByBrand = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const brand = emergingBrandToken(candidate.name);
    if (!brand) continue;
    (candidatesByBrand.get(brand) ?? candidatesByBrand.set(brand, new Set()).get(brand)!)
      .add(candidate.normKey);
  }
  return new Set(
    [...candidatesByBrand].filter(([, names]) => names.size >= 2).map(([brand]) => brand),
  );
}

/**
 * Is a typed item a BRANDED product worth adding (vs a generic noun)? Accepts when
 * the leading tokens match a known catalog brand OR the name has a real model token
 * (a digit/model code) alongside a distinctive word. Rejects all-generic names.
 */
export function isBrandedTypedItem(p: {
  brand?: string | null;
  name: string;
  knownBrands: Set<string>;
  emergingBrands?: ReadonlySet<string>;
}): boolean {
  const toks = tokens([p.brand, p.name].filter(Boolean).join(" "));
  if (!toks.length) return false;
  const nonNumeric = toks.filter((t) => !/^\d+(\.\d+)?$/.test(t));
  // a bare generic noun phrase ("tent", "water bottle", "2 person tent") → reject
  if (nonNumeric.length && nonNumeric.every((t) => GENERIC_GEAR_TERMS.has(t))) return false;
  // known-brand prefix (brands can be multi-word: "sea to summit")
  for (let n = Math.min(4, toks.length); n >= 1; n--) {
    if (p.knownBrands.has(toks.slice(0, n).join(" "))) return true;
  }
  if (uniqueKnownBrandForFirstWord(toks[0], p.knownBrands)) return true;
  if (p.emergingBrands?.has(toks[0]!)) return true;
  // clear product shape: a model token (alnum-with-digit or a 2+ digit number) plus
  // a distinctive (non-generic) word
  const hasModel = toks.some((t) => (/\d/.test(t) && /[a-z]/i.test(t)) || /^\d{2,}$/.test(t));
  const hasDistinctive = nonNumeric.some((t) => t.length >= 2 && !GENERIC_GEAR_TERMS.has(t));
  return hasModel && hasDistinctive;
}

/**
 * A known brand at the front of a typed name, split out: "Zpacks Duplex" → brand
 * "Zpacks", name "Duplex", spelled the way the catalog spells the brand. A typed row
 * has no brand field (the name line is one string), so this is how a community row
 * promoted from typed rows comes to carry a brand like the cited rows do. Longest
 * match first, up to four words ("Sea to Summit"); the whole name being a brand is
 * not a split (there would be no product left). `spellings` maps normKey(brand) to
 * the catalog's own spelling.
 */
export function splitKnownBrand(
  name: string,
  spellings: ReadonlyMap<string, string>,
  emergingBrands?: ReadonlySet<string>,
): { brand: string | null; name: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, words.length - 1); n >= 1; n--) {
    const brand = spellings.get(normKey(words.slice(0, n).join(" ")));
    if (brand) return { brand, name: words.slice(n).join(" ") };
  }
  const known = uniqueKnownBrandForFirstWord(normKey(words[0]), spellings.keys());
  if (known) return { brand: spellings.get(known)!, name: words.slice(1).join(" ") };
  if (emergingBrands?.has(normKey(words[0]))) return { brand: words[0]!, name: words.slice(1).join(" ") };
  return { brand: null, name: name.trim() };
}

// --- Variant canonical formatting -----------------------------------------
// `variant` is a single free-text slot that crams multiple dimensions (fabric,
// size, temp, volume). normalizeVariant() gives it ONE consistent style so the
// catalog reads like a spec sheet and the UI can render it predictably:
//   • dimensions separated by ", "
//   • orphan leading/trailing punctuation stripped ("/ M" → "M", ", 18F" → "18F")
//   • temperature: no degree symbol, no space, uppercase ("20°F" → "20F", "-6 c" → "-6C")
//   • volume: no parens/space, uppercase L ("(68 L)" → "68L")
//   • trailing parenthetical qualifiers unwrapped ("Regular (6 ft)" → "Regular, 6 ft")
//   • an S/M/L-family size is a WORD: "M" → "Medium", "Men's M" → "Men's Medium",
//     "XS" → "X-Small", "M torso" → "Medium torso" (Ryan, 2026-09-12: "I want the
//     catalogue to say Medium"; it reverses the 2026-09-05 letters rule). A range
//     stays as the maker writes it ("S/M", "L/XL"), and so does a letter the maker
//     uses as a scale of its own ("M+", "Size D"). The attributes column keeps the
//     letter (scripts/catalogAttributes reads the word back to it), so search and
//     the size axis are untouched; only what a person reads changes.
//   • no "Size" prefix before such a size ("Size M" → "Medium"; "Size D" / "Size 9"
//     keep theirs — an insole letter or a shoe number isn't self-describing alone)
//   • a gender prefix takes no comma ("Men's, M" → "Men's Medium", the house form)
//   • a number and its unit are one token — "6 ft" → "6ft", "400 ml" → "400ml", "1 m" →
//     "1m" — matching the "68L" / "20F" forms above; prime marks spell out as ft / in
//     ("9'" → "9ft", '17" torso' → "17in torso") so a variant never carries a bare quote
//   • quantity phrasing: "3 Pack" → "3-pack"; "Set of 4" / "Sleeve of 10" → lowercase
//   • KEEP genuine tokens: size ranges ("S/M", "L/XL", "M/L torso") and spaced
//     unit/temperature equivalents ("32oz / 1L", "20F / -6C", '16" / 19"')
//   • a "|" between dimensions is treated like a top-level comma ("M's 9 | W's 10"
//     → "M's 9, W's 10") — it's a transcription artifact from manufacturer quotes,
//     never a canonical separator

/** The units a number closes up to ("6 ft" → "6ft"). normalizeVariant folds these and
 *  scripts/catalogChecks.ts refuses a variant that still spaces one. */
export const SPACED_UNITS = "ft|in|yd|cm|mm|m|km|g|kg|oz|lb|ml|qt|gal|mAh|gsm";
const SPACED_UNIT = new RegExp(String.raw`(\d)\s+(${SPACED_UNITS})\b`, "g");

// crude "looks like a measured value": has a digit AND a unit-ish char (letter, ", ')
const hasNumUnit = (s: string) => /\d/.test(s) && /[a-zA-Z"']/.test(s);

/** The S/M/L family, letter to word and back. The catalog's variant says the word;
 *  the attributes column and the size axis keep the letter. */
export const SIZE_LETTER_WORD: Record<string, string> = {
  XXS: "XX-Small",
  XS: "X-Small",
  S: "Small",
  M: "Medium",
  L: "Large",
  XL: "X-Large",
  XXL: "XX-Large",
};
/** The same family read the other way, keyed by the word in lower case ("x-large" → "XL"),
 *  since a research row or a person may spell "medium". */
export const SIZE_WORD_LETTER: Record<string, string> = Object.fromEntries(
  Object.entries(SIZE_LETTER_WORD).map(([letter, word]) => [word.toLowerCase(), letter]),
);
// a letter size standing as a token: at the start of the string or after a space, a
// comma or an opening paren; followed by the end, a space, a comma or a closing paren.
// NOT before "/" or "+" (a range or the maker's own "M+"), not "M's" (a footwear
// abbreviation of Men's), and not the L of a litre written with a space ("27 L",
// which normalizeVariant closes up to "27L" but a raw research row may still carry).
const LETTER_TOKEN = /(^|[\s,(])(?<!\d\s*)(XXS|XS|S|M|L|XL|XXL)(?=$|[\s,)])/g;
const WORD_TOKEN = /(^|[\s,(])(XX-Small|X-Small|Small|Medium|Large|X-Large|XX-Large)(?=$|[\s,)])/gi;

/** "M" → "Medium", "Men's M" → "Men's Medium", "M torso" → "Medium torso"; ranges and
 *  everything else untouched. */
export function sizeLettersToWords(v: string): string {
  return v.replace(LETTER_TOKEN, (_m, lead: string, letter: string) => lead + SIZE_LETTER_WORD[letter]!);
}
/** The inverse, for the attributes reader: "Medium" → "M". Case-insensitive on the
 *  way in, since a research row may spell "medium". */
export function sizeWordsToLetters(v: string): string {
  return v.replace(WORD_TOKEN, (_m, lead: string, word: string) => lead + SIZE_WORD_LETTER[word.toLowerCase()]!);
}

/** Strip orphan leading/trailing separators + whitespace from one dimension. */
function cleanDim(s: string): string {
  return s.replace(/^[\s,/]+/, "").replace(/[\s,/]+$/, "").replace(/\s+/g, " ").trim();
}

export function normalizeVariant(input: string | null | undefined): string {
  let v = (input ?? "").trim();
  if (!v) return "";
  // 1. unwrap trailing/inline parenthetical qualifiers into ", " dimensions
  v = v.replace(/\s*\(\s*([^()]*?)\s*\)/g, (_m, inner: string) => `, ${inner.trim()}`);
  // 1b. "Size M" → "M": the prefix only ever precedes an S/M/L-family letter that stands
  //     on its own; "Size D" (insole) and "Size 9" (shoe) are left for the footwear rule
  v = v.replace(/\bsize\s+(?=(?:xxs|xs|s|m|l|xl|xxl)\b)/gi, "");
  // 1c. prime marks → ft / in ("9'" → "9ft", '20"' → "20in", "5' x 8.5'" → "5ft x 8.5ft");
  //     a vulgar fraction counts as a number ("⅝\"" → "⅝in")
  v = v
    .replace(/(\d(?:\.\d+)?|[⅛¼⅜½⅝¾⅞])\s*'(?!s\b)/g, "$1ft")
    .replace(/(\d(?:\.\d+)?|[⅛¼⅜½⅝¾⅞])\s*"/g, "$1in")
    .replace(/ft(?=\d)/g, "ft "); // 5'6" → "5ft 6in", not "5ft6in"
  // 1d. number + unit are one token: "6 ft" → "6ft", "400 ml" → "400ml", "1 m" → "1m".
  //     Only these units — never a size scale ("Size 9", "JP 3", "US 9", "Ultra 200X").
  v = v.replace(SPACED_UNIT, "$1$2");
  // 1e. quantity phrasing: "3 Pack" / "3 pack" → "3-pack"; "Set of 4" → "set of 4"
  v = v.replace(/\b(\d+)[\s-]?[Pp]ack\b/g, "$1-pack").replace(/\b(Set|Sleeve|Bag|Box|Bottle|Package|Roll|Tin|Tube) of\b/g, (m) => m.toLowerCase());
  // 2. temperature: "20°F" / "20 F" / "-6 c" → "20F" / "-6C" (degree dropped, uppercased)
  v = v.replace(/(-?\d+(?:\.\d+)?)\s*°?\s*([FfCc])\b/g, (_m, n: string, u: string) => `${n}${u.toUpperCase()}`);
  // 3. volume: a number followed by L (with optional space) → "<n>L" (only when a digit precedes L,
  //    so size letters like the L in "L/XL" are untouched; "90mL" untouched — 'm' breaks the match)
  v = v.replace(/\b(\d+(?:\.\d+)?)\s*[lL]\b/g, (_m, n: string) => `${n}L`);
  // 4. split into dimensions: top-level commas (and "|", a non-canonical separator
  //    copied from manufacturer quotes), then SPACED " / " separators (an UNSPACED
  //    "/" stays inside its token — that's a real size range like S/M or M/L)
  const dims: string[] = [];
  for (const seg of v.split(/[,|]/)) {
    const parts = seg.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.every(hasNumUnit)) {
      // a spaced unit/temp equivalent ("32oz / 1L", "20F / -6C") — keep joined with " / "
      dims.push(parts.join(" / "));
    } else {
      // distinct dimensions ("Ultra 200X / M" → two) — or a single token
      for (const p of parts) dims.push(p);
    }
  }
  const joined = dims
    .map(cleanDim)
    .filter(Boolean)
    .join(", ")
    // a gender prefix and its size are ONE dimension: "Men's, M" → "Men's M"
    .replace(/\b(Men's|Women's), (?=(?:XXS|XS|S|M|L|XL|XXL|XX-Small|X-Small|Small|Medium|Large|X-Large|XX-Large)\b)/gi, "$1 ");
  // 5. the size as a word (see the header)
  return sizeLettersToWords(joined);
}
