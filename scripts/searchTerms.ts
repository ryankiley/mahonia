// Search-side vocabulary: the extra words a catalog row should be findable by
// beyond its brand + model name. Two problems it solves, both search-only (no UI):
//
//   1. CATEGORY search — a tent is named "Copper Spur" / "X-Mid", never "tent", so
//      typing "tent" finds nothing. We derive a canonical noun for each row and
//      materialize it into catalog_items.search_terms at seed time, so the fuzzy
//      search (which matches brand + name + search_terms) can hit it.
//   2. LOCALE / SYNONYM search — a UK user types "rucksack", a US user types
//      "backpack"; both should find the same packs. We fold every alias that points
//      at a noun into that noun's search_terms, so either term matches.
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
  "hip pack",
  "trekking poles",
  "tent poles",
  "water filter",
  "water bottle",
  "water bladder",
  "fuel canister",
  "first aid kit",
  "repair kit",
  "power bank",
  "battery pack",
  "rain jacket",
  "rain pants",
  "wind jacket",
  "wind pants",
  "down jacket",
  "base layer",
  "bug net",
  "head net",
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
  "footprint",
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
  "buff",
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
const ALIASES: Record<string, string> = {
  "air mattress": "sleeping pad",
  "sleeping mat": "sleeping pad",
  mattress: "sleeping pad",
  mat: "sleeping pad",
  "head torch": "headlamp",
  torch: "flashlight",
  rucksack: "backpack",
  "torso pad": "sleeping pad",
  "wind shirt": "wind jacket",
  puffy: "down jacket",
  toque: "beanie",
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

// One precompiled matcher per pattern (nouns map to themselves; aliases map to
// their canon). Optional trailing "s" covers the plural-name / singular-canon
// direction and its inverse. Longest pattern wins across BOTH lists.
const MATCHERS: ReadonlyArray<{ canon: string; re: RegExp }> = [
  ...NOUNS.map((n) => [n, n] as const),
  ...Object.entries(ALIASES),
]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([pattern, canon]) => ({
    canon,
    re: new RegExp(`\\b${esc(pattern.endsWith("s") ? pattern.slice(0, -1) : pattern)}s?\\b`, "i"),
  }));

// Reverse index: canonical noun → the alias tokens that point at it. Built once so
// buildSearchTerms doesn't re-scan ALIASES per row.
const ALIASES_BY_CANON: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [alias, canon] of Object.entries(ALIASES)) (out[canon] ??= []).push(alias);
  return out;
})();

/** The canonical noun a product name implies, or null when nothing matches. */
export function deriveNoun(productName: string): string | null {
  for (const { canon, re } of MATCHERS) if (re.test(productName)) return canon;
  return null;
}

/**
 * The space-joined extra search words for a catalog row: its canonical noun (from
 * the name, else a per-category default) plus every alias/locale variant for that
 * noun. Returns null when no noun can be determined (row stays name-searchable
 * only). Stored in catalog_items.search_terms and folded into the fuzzy match.
 */
export function buildSearchTerms(name: string, categoryHint: string | null): string | null {
  const noun = deriveNoun(name) ?? (categoryHint ? CATEGORY_DEFAULT_NOUN[categoryHint] : null) ?? null;
  if (!noun) return null;
  const terms = new Set<string>([noun, ...(ALIASES_BY_CANON[noun] ?? [])]);
  return [...terms].join(" ");
}
