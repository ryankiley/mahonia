// Pure catalog data-quality helpers shared by the build pipeline, the runtime
// server (community intake), and tests. No DB, no node-only deps.

// Plausible weight range per category, grams. Loose — catches gross slips
// (a 50 g tent, a 5 kg stove), not borderline judgment calls. (Relocated here
// from scripts/catalogChecks so server intake can validate without a scripts/ import.)
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

// --- community intake (Phase 3) -------------------------------------------

/** Normalize a string to a comparison key: lowercase, non-alphanumerics→space. */
export function normKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
 * Is a typed item a BRANDED product worth adding (vs a generic noun)? Accepts when
 * the leading tokens match a known catalog brand OR the name has a real model token
 * (a digit/model code) alongside a distinctive word. Rejects all-generic names.
 */
export function isBrandedTypedItem(p: {
  brand?: string | null;
  name: string;
  knownBrands: Set<string>;
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
  // clear product shape: a model token (alnum-with-digit or a 2+ digit number) plus
  // a distinctive (non-generic) word
  const hasModel = toks.some((t) => (/\d/.test(t) && /[a-z]/i.test(t)) || /^\d{2,}$/.test(t));
  const hasDistinctive = nonNumeric.some((t) => t.length >= 2 && !GENERIC_GEAR_TERMS.has(t));
  return hasModel && hasDistinctive;
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
//   • KEEP genuine tokens: size ranges ("S/M", "L/XL", "M/L torso") and spaced
//     unit/temperature equivalents ("32oz / 1L", "20F / -6C", '16" / 19"')

const SIZE_TOKEN = /^W?(XS|S|M|L|XL|XXL|XXXL)$/i;
const isSizeTok = (s: string) => SIZE_TOKEN.test(s.trim());
// crude "looks like a measured value": has a digit AND a unit-ish char (letter, ", ')
const hasNumUnit = (s: string) => /\d/.test(s) && /[a-zA-Z"']/.test(s);

/** Strip orphan leading/trailing separators + whitespace from one dimension. */
function cleanDim(s: string): string {
  return s.replace(/^[\s,/]+/, "").replace(/[\s,/]+$/, "").replace(/\s+/g, " ").trim();
}

export function normalizeVariant(input: string | null | undefined): string {
  let v = (input ?? "").trim();
  if (!v) return "";
  // 1. unwrap trailing/inline parenthetical qualifiers into ", " dimensions
  v = v.replace(/\s*\(\s*([^()]*?)\s*\)/g, (_m, inner: string) => `, ${inner.trim()}`);
  // 2. temperature: "20°F" / "20 F" / "-6 c" → "20F" / "-6C" (degree dropped, uppercased)
  v = v.replace(/(-?\d+(?:\.\d+)?)\s*°?\s*([FfCc])\b/g, (_m, n: string, u: string) => `${n}${u.toUpperCase()}`);
  // 3. volume: a number followed by L (with optional space) → "<n>L" (only when a digit precedes L,
  //    so size letters like the L in "L/XL" are untouched; "90mL" untouched — 'm' breaks the match)
  v = v.replace(/\b(\d+(?:\.\d+)?)\s*[lL]\b/g, (_m, n: string) => `${n}L`);
  // 4. split into dimensions: top-level commas, then SPACED " / " separators (an UNSPACED "/" stays
  //    inside its token — that's a real size range like S/M or M/L)
  const dims: string[] = [];
  for (const seg of v.split(",")) {
    const parts = seg.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.every(hasNumUnit)) {
      // a spaced unit/temp equivalent ("32oz / 1L", "20F / -6C") — keep joined with " / "
      dims.push(parts.join(" / "));
    } else {
      // distinct dimensions ("Ultra 200X / M" → two) — or a single token
      for (const p of parts) dims.push(p);
    }
  }
  return dims.map(cleanDim).filter(Boolean).join(", ");
}
