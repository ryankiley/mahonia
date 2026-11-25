// A size as a person types it, read for comparing with a catalog row. Two questions use
// it: does a piece of My Gear contradict the size of the row it is linked to
// (sizeConflict, for edit_my_gear's catalog_id and verify_catalog_item's gear_id), and
// does a variant say anything beyond its cut (namesSize, for a scale weight of gear sold
// by size).
//
// The axes are read by the catalog build's own reader (extractAttributes in
// scripts/catalogAttributes.ts), which knows only the catalog's canonical forms ("Men's
// Medium", "20F, Regular Wide", "Men's US 9"), so what people type is folded toward them
// first: "mens med", "850fp", "US9", "30 liter", "pack of 2", "Large/X-Large".
//
// On purpose, a link is refused only for an outright contradiction: an axis both sides
// state, stated differently. A piece that says less than its row ("Regular" against
// "Regular Wide"), or says it in words the reader doesn't place ("carbon poles"), links.
// Telling those apart took a reader three times this size that two reviews still found
// holes in, to guard a link that changes little: a piece keeps its own name, variant and
// weight when it is linked.

import { extractAttributes, SHOE_REGIONS } from "../../scripts/catalogAttributes";
import { normalizeVariant, normKey, SIZE_LETTER_WORD } from "../../shared/catalogQuality";

/** A catalog row as the size check reads it: its variant, and the gear type and kind
 *  the variant's tokens are read by ("Regular" is a length on a quilt, a torso on a pack). */
export interface SizeRow {
  variant: string | null;
  commonName?: string | null;
  categoryHint?: string | null;
}

// size words in the catalog's own case, longest first so "X-Large" wins over "Large";
// a hyphen may be typed as a space or left out ("x large", "xlarge")
const SIZE_WORDS = ["XXX-Large", "XX-Large", "X-Large", "XX-Small", "X-Small", "Small", "Medium", "Large", "Regular", "Short", "Long", "Tall", "Wide", "Slim", "Petite", "Standard", "Jumbo", "Mini", "Nano", "Big", "Person", "Mummy"];
const SIZE_WORD_RE = SIZE_WORDS.map((w) => [new RegExp(`\\b${w.replace("-", "[- ]?")}\\b`, "gi"), w] as const);
// the S/M/L family's words back to the catalog's letters (SIZE_LETTER_WORD); no word is the
// start of another, so the order they are tried in can't matter
const WORD_LETTER: Record<string, string> = Object.fromEntries(Object.entries(SIZE_LETTER_WORD).map(([letter, word]) => [word, letter]));
const RANGE_WORD = Object.keys(WORD_LETTER).join("|");
// a shoe size with its region on either side, in the regions the catalog writes one in
const REGION_THEN_SIZE = new RegExp(`\\b(${SHOE_REGIONS})\\s*(\\d{1,2}(?:\\.5)?)\\b`, "gi");
const SIZE_THEN_REGION = new RegExp(`\\b(\\d{1,2}(?:\\.5)?)\\s*(${SHOE_REGIONS})\\b`, "gi");
// a pack count as people type it ("pack of 2", "2pk"), to the catalog's "2-pack"
const PACK_TYPED = /\bpack of (\d+)\b|\b(\d+)\s*-?\s*pk\b/gi;
const asPack = (_m: string, packOf?: string, pk?: string) => `${packOf ?? pk}-pack`;
const PACK_COUNT = /\b(\d+)-pack\b/i;

/** What people type, folded toward the forms the reader knows. Idempotent on a
 *  catalog row's own variant. */
function foldTyped(variant: string): string {
  let v = variant.replace(/[’‘´`]/g, "'");
  v = v
    .replace(/\bextra[- ]?(large|small|wide)\b/gi, (_m, w: string) => (w.toLowerCase() === "wide" ? "Extra Wide" : `X-${w}`))
    .replace(/\b(?:women'?s|w's)(?![\w'])/gi, "Women's")
    .replace(/\b(?:men'?s|m's)(?![\w'])/gi, "Men's")
    .replace(/\breg\b/gi, "Regular")
    .replace(/\bmed\b/gi, "Medium")
    .replace(/\bl(?:r)?g\b/gi, "Large")
    .replace(/\bsml?\b/gi, "Small");
  for (const [re, word] of SIZE_WORD_RE) v = v.replace(re, word);
  v = v
    .replace(/\bXXX-Large\b/g, "XXXL")
    // Osprey's women's fits ("wm/l" is "WM/L")
    .replace(/\bw(xs\/s|s\/m|m\/l|l\/xl)\b/gi, (_m, r: string) => `W${r.toUpperCase()}`)
    // a range in words is the catalog's letters ("Large/X-Large" is "L/XL")
    .replace(new RegExp(`\\b(${RANGE_WORD})(?=/)`, "g"), (w) => WORD_LETTER[w]!)
    .replace(new RegExp(`(?<=/)(${RANGE_WORD})\\b`, "g"), (w) => WORD_LETTER[w]!)
    // a bare size letter in any case, but not the m of "2 m" or the l of "1 l"
    .replace(/(?<![\w'])(?<!\d\s*)(xxxl|3xl|2xl|xxl|xxs|xl|xs|s|m|l)(?![\w'])/gi, (s) => s.toUpperCase())
    .replace(/(\d{3})(\+?)\s*(?:fp|fill(?: power)?)\b/gi, "$1$2FP")
    .replace(REGION_THEN_SIZE, (_m, r: string, n: string) => `${r.toUpperCase()} ${n}`)
    .replace(SIZE_THEN_REGION, (_m, n: string, r: string) => `${r.toUpperCase()} ${n}`)
    .replace(PACK_TYPED, asPack)
    .replace(/(\d+(?:\.\d+)?)\s*(?:liters?|litres?|ltr)\b/gi, "$1L")
    .replace(/(-?\d+)\s*(?:deg(?:ree)?s?\s*|°\s*)(c)\b/gi, "$1C")
    .replace(/(-?\d+)\s*(?:deg(?:ree)?s?|°)(?:\s*f\b)?(?!\s*[cC]\b)/gi, "$1F")
    .replace(/\b(\d(?:\.\d)?)\s*-?\s*(?:Person|persons|people|p)\b/gi, "$1P")
    .replace(/\bul(\d)\b/gi, "UL$1");
  return normalizeVariant(v);
}

/** The axes a variant states, read by the build's reader after folding. A half size is a
 *  shoe's, in the catalog's default region ("Men's 8.5" is "Men's US 8.5"); a whole number
 *  after a cut can be a waist, so it is left as typed. */
const partsOf = (variant: string) =>
  foldTyped(variant)
    .split(/,\s*/)
    .map((p) => p.trim().replace(/^((?:Men's|Women's) )?(\d{1,2}\.5)$/, (_m, cut: string | undefined, n: string) => `${cut ?? ""}US ${n}`))
    .filter(Boolean);

/** The axes a variant states. Each part is read without the words typed after its size
 *  when that reads more ("Men's Medium Black" is "Men's Medium"); a pack count is an axis
 *  of its own, which the build's reader leaves to the variant's text. */
function axesOf(variant: string, row: SizeRow): Record<string, unknown> {
  const read = (parts: string[]) => extractAttributes(parts.join(", "), row.commonName, row.categoryHint) as Record<string, unknown>;
  const parts = partsOf(variant).map((part) => {
    const words = part.split(" ");
    let best = part;
    let most = Object.keys(read([part])).length;
    for (let n = words.length - 1; n >= 1; n--) {
      const prefix = words.slice(0, n).join(" ");
      const count = Object.keys(read([prefix])).length;
      if (count > most) [best, most] = [prefix, count];
    }
    return best;
  });
  const axes = read(parts);
  // as typed, then as the catalog would write it: normalizeVariant folds "2 Pack" and
  // "2pack" to "2-pack" too, and read only as typed those stated no count, so a 2-pack
  // linked to a 3-pack row. What was read before is read first, and reads the same.
  const pack = PACK_COUNT.exec(variant.replace(PACK_TYPED, asPack)) ?? PACK_COUNT.exec(foldTyped(variant));
  return pack ? { ...axes, pack: pack[1] } : axes;
}

/** A bare shoe number is the US one, the catalog's own default region. */
const sizeValue = (key: string, v: unknown) => {
  const s = String(v).toLowerCase();
  return key === "size" ? s.replace(/^us /, "") : s;
};

/**
 * True when a piece's variant and a catalog row's state the same axis differently:
 * "Medium" against "Large", "Men's" against "Women's", "US 9" against "US 9.5". Nothing
 * else refuses: no variant on either side, an axis only one side states, words no axis
 * reads. A row naming one product under two labels ("Men's US 9 / Women's US 10") matches
 * either.
 */
export function sizeConflict(pieceVariant: string | null | undefined, row: SizeRow): boolean {
  if (!pieceVariant?.trim() || !row.variant?.trim()) return false;
  // every part the row has, in the piece's own words: the row's size, whatever its order
  const own = new Set(partsOf(pieceVariant).map(normKey));
  if (partsOf(row.variant).every((part) => own.has(normKey(part)))) return false;
  const mine = axesOf(pieceVariant, row);
  return row.variant.split(" / ").every((label) => {
    const theirs = axesOf(label, row);
    return Object.keys(mine).some((key) => key in theirs && sizeValue(key, mine[key]) !== sizeValue(key, theirs[key]));
  });
}

/** Whether a variant says anything beyond its cut, for a scale weight of gear sold by
 *  size: "Men's" alone names no size, "Men's 32x30" does. */
export function namesSize(variant: string | null | undefined): boolean {
  return /[a-z0-9]/i.test(foldTyped(variant ?? "").replace(/\b(?:Men's|Women's|Unisex)/g, ""));
}
