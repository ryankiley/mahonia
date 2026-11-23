// A size as a person types it, read for comparing with a catalog row. Two questions use
// it: is a piece of My Gear the same size as the row it is linked to (sizeConflict, for
// edit_my_gear's catalog_id and verify_catalog_item's gear_id), and does a variant name a
// size at all (namesSize, for a scale weight of gear sold by size).
//
// Both go through the catalog build's own reader (extractAttributes in
// scripts/catalogAttributes.ts), which reads only the catalog's canonical forms: "Men's
// Medium", "20F, Regular Wide", "Men's US 9". What people type is folded toward those
// forms first (readSize):
//   • case, apostrophes and abbreviations: "mens medium", "Men’s Med", "reg wide";
//   • the other spellings of one figure: "850fp", "950 fill", "US9", "9 US", "30 liter",
//     "20 degree", "pack of 2", "2pk", "Large/X-Large";
//   • words run together without commas: "20F Regular Wide", "Men's Medium Black". A part
//     the reader reads less of whole than split is split where it reads the most;
//   • a word the reader passes over ("Black", "Solar", "Mummy" in "Regular Mummy", the
//     "Short" a rain jacket has no inseam for) is kept as a word (`rest`), so it still
//     tells two rows apart.
// None of it changes how a catalog row's own variant reads, only what a typed one can match.

import { extractAttributes } from "../../scripts/catalogAttributes";
import { normalizeVariant, normKey } from "../../shared/catalogQuality";

/** A catalog row as the size checks read it: its variant, and the gear type and kind
 *  the variant's tokens are read by ("Regular" is a length on a quilt, a torso on a pack). */
export interface SizeRow {
  variant: string | null;
  commonName?: string | null;
  categoryHint?: string | null;
}

type Axes = Record<string, unknown>;

// size words in the catalog's own case, longest first so "X-Large" wins over "Large";
// a hyphen may be typed as a space or left out ("x large", "xlarge")
const SIZE_WORDS = ["XXX-Large", "XX-Large", "X-Large", "XX-Small", "X-Small", "Small", "Medium", "Large", "Regular", "Short", "Long", "Tall", "Wide", "Slim", "Petite", "Standard", "Jumbo", "Mini", "Nano", "Big", "Person", "Mummy"];
const SIZE_WORD_RE = SIZE_WORDS.map((w) => [new RegExp(`\\b${w.replace("-", "[- ]?")}\\b`, "gi"), w] as const);
const WORD_LETTER: Record<string, string> = { "XX-Small": "XXS", "X-Small": "XS", Small: "S", Medium: "M", Large: "L", "X-Large": "XL", "XX-Large": "XXL" };
const RANGE_WORD = "XX-Small|X-Small|XX-Large|X-Large|Small|Medium|Large";
// words beside a figure that say nothing a row could differ by ("650FP down", "M torso")
const NOISE = new Set(["down", "torso", "hank", "power", "bank", "net", "fuel", "size"]);
// words that say a size the reader can't place ("Standard", "Plus", "Double"): one the
// piece has and the row doesn't is another size, never an owner's own word like a colour
const SIZE_LIKE = new Set(["standard", "plus", "double", "single", "mini", "jumbo", "big", "nano", "petite", "tall", "wide", "slim", "short", "long", "regular", "small", "medium", "large", "compact", "junior", "youth", "kids", "xxs", "xs", "xl", "xxl", "xxxl"]);

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
    .replace(/\b(us|uk|eu|jp)\s*(\d{1,2}(?:\.5)?)\b/gi, (_m, r: string, n: string) => `${r.toUpperCase()} ${n}`)
    .replace(/\b(\d{1,2}(?:\.5)?)\s*(us|uk|eu|jp)\b/gi, (_m, n: string, r: string) => `${r.toUpperCase()} ${n}`)
    .replace(/\bpack of (\d+)\b/gi, "$1-pack")
    .replace(/\b(\d+)\s*-?\s*pk\b/gi, "$1-pack")
    .replace(/(\d+(?:\.\d+)?)\s*(?:liters?|litres?|ltr)\b/gi, "$1L")
    .replace(/(-?\d+)\s*(?:deg(?:ree)?s?\s*|°\s*)(c)\b/gi, "$1C")
    .replace(/(-?\d+)\s*(?:deg(?:ree)?s?|°)(?:\s*f\b)?(?!\s*[cC]\b)/gi, "$1F")
    .replace(/\b(\d(?:\.\d)?)\s*-?\s*(?:Person|persons|people|p)\b/gi, "$1P")
    .replace(/\bul(\d)\b/gi, "UL$1");
  return normalizeVariant(v);
}

// a half size is a shoe's, in the catalog's default region ("Men's 8.5" is "Men's US 8.5");
// a whole number after a cut can be a waist, so it is left as typed
const partsOf = (variant: string) =>
  foldTyped(variant)
    .split(/,\s*/)
    .map((p) => p.trim().replace(/^((?:Men's|Women's) )?(\d{1,2}\.5)$/, (_m, cut: string | undefined, n: string) => `${cut ?? ""}US ${n}`))
    .filter(Boolean);

const read = (parts: string[], row: SizeRow): Axes => extractAttributes(parts.join(", "), row.commonName, row.categoryHint) as Axes;
const sameAxes = (a: Axes, b: Axes) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => String(a[k]) === String(b[k]));
};

/** Each part split at the spaces that let the whole variant read the most axes, when
 *  splitting reads more than leaving it whole: "20F Regular Wide" → "20F", "Regular
 *  Wide"; "Men's Medium Black" → "Men's Medium", "Black". Between splits that read as
 *  many, the one leaving fewer words unread ("5ft 6in", "Black", not "5ft", "6in Black").
 *  A part in `asWritten` (the row's own) is read as the row reads it, never split. */
function segmented(parts: string[], row: SizeRow, asWritten: ReadonlySet<string>): string[] {
  const out = [...parts];
  for (let i = 0; i < out.length; i++) {
    const words = out[i]!.split(" ");
    if (words.length < 2 || words.length > 8 || asWritten.has(normKey(out[i]))) continue;
    const at = (candidate: string) => Object.keys(read([...out.slice(0, i), candidate, ...out.slice(i + 1)], row)).length;
    const unread = (pieces: string[]) => pieces.reduce((n, p) => n + (Object.keys(read([p], row)).length ? 0 : p.split(" ").length), 0);
    let best = out[i]!;
    let bestN = at(best);
    let bestUnread = Infinity;
    for (let mask = 1; mask < 1 << (words.length - 1); mask++) {
      const pieces: string[] = [];
      let cur = words[0]!;
      for (let j = 1; j < words.length; j++) {
        if (mask & (1 << (j - 1))) {
          pieces.push(cur);
          cur = words[j]!;
        } else cur += ` ${words[j]}`;
      }
      pieces.push(cur);
      const candidate = pieces.join(", ");
      const n = at(candidate);
      if (n < bestN || (n === bestN && bestUnread === Infinity)) continue;
      const u = unread(pieces);
      if (n > bestN || u < bestUnread) {
        bestN = n;
        bestUnread = u;
        best = candidate;
      }
    }
    out[i] = best;
  }
  return out.flatMap((p) => p.split(", "));
}

/** A variant's axes, and the words in it that no axis accounts for (folded). */
function readParts(parts: string[], row: SizeRow, asWritten: ReadonlySet<string>): { axes: Axes; rest: string[] } {
  const kept = segmented(parts, row, asWritten);
  const axes = read(kept, row);
  const rest = new Set<string>();
  // a word whose removal leaves the reading as it was is not part of any axis: kept as a
  // word ("Black", "Solar", the "Mummy" a length token swallows)
  for (let p = 0; p < kept.length; p++) {
    const words = kept[p]!.split(" ");
    for (let w = 0; w < words.length; w++) {
      const word = normKey(words[w]!);
      if (!word || NOISE.has(word)) continue;
      const without = words.filter((_, i) => i !== w).join(" ");
      const others = [...kept.slice(0, p), ...(without ? [without] : []), ...kept.slice(p + 1)];
      if (sameAxes(read(others, row), axes)) rest.add(word);
    }
  }
  return { axes, rest: [...rest] };
}

/** A typed variant read as a size: its axes by the build's reader, after folding, and
 *  the words no axis accounts for. */
export function readSize(variant: string | null | undefined, row: Omit<SizeRow, "variant">): { axes: Axes; rest: string[] } {
  if (!variant?.trim()) return { axes: {}, rest: [] };
  return readParts(partsOf(variant), { ...row, variant }, new Set());
}

/** Whether a variant names a size, for gear sold by size: an axis besides the cut
 *  ("Men's" alone names none), or a word the reader can't place, which a person reads as
 *  the size ("Men's 32x30") and the tool can't tell from one. */
export function namesSize(variant: string | null | undefined, row: Omit<SizeRow, "variant">): boolean {
  const { axes, rest } = readSize(variant, row);
  return Object.keys(axes).some((k) => k !== "fit") || rest.length > 0;
}

/** A variant that names two labels in one dimension ("Men's US 9 / Women's US 10", one
 *  shoe sold under both) as each label alone, so either one matches. */
function alternativesOf(parts: string[], row: SizeRow): string[][] {
  let alts: string[][] = [[]];
  for (const part of parts) {
    const sides = part.includes(" / ") && !Object.keys(read([part], row)).length ? part.split(" / ") : [part];
    alts = alts.flatMap((alt) => sides.map((side) => [...alt, side]));
    if (alts.length > 8) return [parts];
  }
  return alts;
}

/** A piece's part that holds one of the row's parts whole with words beside it ("Men's
 *  Medium Black" against "Men's Medium") as that part and the words apart, so the row's
 *  part reads as the row reads it. */
function rowPartsOut(pieceParts: string[], rowParts: string[], row: SizeRow): string[] {
  const rows = rowParts.map((r) => r.split(" ")).sort((a, b) => b.length - a.length);
  return pieceParts.flatMap((part) => {
    const words = part.split(" ");
    for (const rw of rows) {
      if (rw.length >= words.length) continue;
      for (let i = 0; i + rw.length <= words.length; i++) {
        if (!rw.every((w, j) => normKey(w) === normKey(words[i + j]))) continue;
        // not when the word beside it is part of the same figure ("6ft" in "6ft 6in")
        const own = read([rw.join(" ")], row);
        const joins = (text: string) => {
          const a = read([text], row);
          return Object.keys(a).length >= Object.keys(own).length && !sameAxes(a, own);
        };
        if (i + rw.length < words.length && joins([...rw, words[i + rw.length]].join(" "))) continue;
        if (i > 0 && joins([words[i - 1], ...rw].join(" "))) continue;
        return [words.slice(0, i).join(" "), rw.join(" "), words.slice(i + rw.length).join(" ")].filter(Boolean);
      }
    }
    return [part];
  });
}

/** A piece's parts put in the row's order where they are the row's own parts ("Regular,
 *  Short, 10F" against "10F, Short, Regular"): the reader takes a second length word as
 *  the width, so the order is part of the reading. */
function inRowOrder(pieceParts: string[], rowParts: string[]): string[] {
  const at = (p: string) => rowParts.findIndex((r) => normKey(r) === normKey(p));
  const shared = pieceParts.filter((p) => at(p) >= 0).sort((a, b) => at(a) - at(b));
  return [...shared, ...pieceParts.filter((p) => at(p) < 0)];
}

/** A size compared across scales the catalog writes one way: a bare shoe number is the
 *  US one, as the catalog's own default region. */
const sizeValue = (key: string, v: unknown) => {
  const s = String(v).toLowerCase();
  return key === "size" ? s.replace(/^us /, "") : s;
};

/** A catalog row's variant read as the build reads it: whole, never split. */
export function rowSize(row: SizeRow): { axes: Axes; rest: string[] } {
  if (!row.variant?.trim()) return { axes: {}, rest: [] };
  const parts = partsOf(row.variant);
  return readParts(parts, row, new Set(parts.map(normKey)));
}

/** True when the row's variant names only a cut ("Men's", "Women's"): that cut in a size
 *  nobody recorded, which a piece links to by saying the same cut. */
export function cutOnly(row: SizeRow): boolean {
  const keys = Object.keys(rowSize(row).axes);
  return keys.length === 1 && keys[0] === "fit";
}

function conflictWith(pieceParts: string[], rowParts: string[], row: SizeRow): boolean {
  // the row as the build reads it, and the parts the piece shares with it read the same way
  const asWritten = new Set(rowParts.map(normKey));
  const cat = readParts(rowParts, row, asWritten);
  const piece = readParts(inRowOrder(rowPartsOut(pieceParts, rowParts, row), rowParts), row, asWritten);
  if (Object.keys(piece.axes).length) {
    const catKeys = Object.keys(cat.axes);
    if (catKeys.length === 1 && catKeys[0] === "fit") {
      // a row that names only its cut has no size to differ from, but it is that cut: a
      // sized piece says the same one, so a bare "Large" isn't taken for the women's row
      if (sizeValue("fit", piece.axes.fit) !== sizeValue("fit", cat.axes.fit)) return true;
    } else {
      for (const key of new Set([...Object.keys(piece.axes), ...Object.keys(cat.axes)])) {
        const mine = piece.axes[key];
        const theirs = cat.axes[key];
        if (mine === undefined || theirs === undefined) {
          if (key !== "fit") return true;
        } else if (sizeValue(key, mine) !== sizeValue(key, theirs)) return true;
      }
    }
  }
  if (piece.rest.some((word) => SIZE_LIKE.has(word) && !cat.rest.includes(word))) return true;
  return cat.rest.some((word) => !piece.rest.includes(word));
}

/**
 * True when a piece's variant and a catalog row's name two different sizes. A row with
 * no variant names no size to differ from, and a piece with none claims nothing; nor
 * does a piece whose variant reads no axis at all ("Black"). Otherwise axis by axis: a
 * cut ("Men's") may be missing on either side, as people leave it off what they type,
 * but any other axis one side states and the other doesn't, or states otherwise, is
 * another size ("Regular" against "20F, Regular" or "Regular Wide" is refused: the piece
 * is asked to say which). A row that names only its cut matches a piece of that cut in
 * any size. The words the row has beyond its axes ("Solar", "2-pack", "Mummy") the piece
 * has too; the piece's own extra words (a colour, an edition) are its owner's.
 */
export function sizeConflict(pieceVariant: string | null | undefined, row: SizeRow): boolean {
  if (!pieceVariant?.trim() || !row.variant?.trim()) return false;
  const pieces = alternativesOf(partsOf(pieceVariant), row);
  return alternativesOf(partsOf(row.variant), row).every((rowParts) => pieces.every((parts) => conflictWith(parts, rowParts, row)));
}
