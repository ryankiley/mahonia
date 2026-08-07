// The tidy pass every human-typed string makes on its way into a list. Two jobs,
// both pure, both deliberately small:
//
//   1. WHITESPACE. A gear name pasted off a retailer's page arrives carrying that
//      page's formatting — a non-breaking space between the brand and the model, a
//      stray newline from the <li> it was lifted out of, a byte-order mark on the
//      front. None of it is visible anywhere, all of it survives into the export, the
//      share view and the version diff, and a hand-typed "Zpacks Duplex" then compares
//      UNEQUAL to a pasted one that looks identical on screen.
//
//   2. THE POSSESSIVE APOSTROPHE. "Ryan's Timberline" is typed with the straight
//      typewriter apostrophe every keyboard emits, and read beside prose that uses the
//      curly one everywhere else on the site.
//
// The apostrophe rule fires only when a LETTER sits on BOTH sides, and that narrowness
// is the whole design. A letter on each side is exactly what separates a possessive
// from a prime, and this catalog is thick with primes: seed/catalog.csv carries 6'
// guylines and 2" stakes by the dozen, alongside 162 "Men's", 153 "Women's" and 36
// "Arc'teryx". A letter-flanked rule curls every one of the latter and cannot reach
// any of the former, because a foot mark always trails a digit.
//
// Nothing else converts. Straight double quotes stay straight and "--" stays "--":
// deciding whether a " closes a quotation or means inches takes a guess at the
// sentence around it, and on a gear list that guess is wrong more often than right.
// An unconverted 2" reads fine; a 2” is a typo the user didn't make. Same rule
// trailLink.ts derives names by — prefer declining to inventing.
//
// Two further steps the conventional treatment takes, and this doesn't.
//
// The first is an escape hatch. The ambiguity is genuinely unsolvable in the general
// case — a lone ' is both a quote and an apostrophe, so a word-initial one ("'Twas")
// is a coin flip — and the usual answer is to let the writer escape it. A name field
// has nowhere to put a backslash. The rule is therefore kept narrow enough never to
// need one: it only fires where the answer is unambiguous.
//
// The second is rewriting 6' and 2" into true prime marks, which is what typographic
// style actually prescribes for measurements. A prime is unreachable from every
// keyboard a person owns, is near-indistinguishable from a straight mark at body
// size, and picking it means DECIDING that the ' after a digit was a measurement
// rather than a typo or a truncated word. The catalog is full of straight marks we
// don't own besides, so curling ours would move the mismatch rather than close it.
//
// The governing constraint on ALL of it: this runs on text the user cannot re-enter
// afterwards, so a character it removes is a character they have no way to type back.
// That rule is why the primes stay, and it is the rule the first draft of this file
// broke — it stripped U+200C/U+200D and split every emoji a folder name contained.
// Every rule below is scoped to marks that carry no meaning of their own.

// Invisible passengers, and ONLY those: the C0 controls that aren't whitespace, DEL,
// the zero-width space, and the BOM.
//
// U+200C and U+200D (zero-width non-joiner / joiner) are deliberately NOT here, though
// every "strip invisible characters" snippet includes them. They are load-bearing
// characters, not debris. U+200D is the joiner that fuses "woman" and "rocket"
// into the single astronaut glyph — strip it and one emoji becomes two — and U+200C
// is a letter-shaping control in Persian and the Indic scripts, where dropping it
// spells a different word (both are pinned in tidyText.test.ts). Naming a folder
// with an emoji is an ordinary thing to do, and the user could never type it back.
//
// The non-breaking space is also absent, for the opposite reason: \s already matches it,
// so the collapse below folds it into a normal space rather than deleting it, which is
// what it means.
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F\u200B\uFEFF]/g;

// A straight apostrophe with a letter on each side — a possessive or a contraction,
// never a measurement. \p{L} rather than [a-z] so it reads O'Brien, l'eau and
// Arc'teryx alike, and doesn't quietly skip an accented brand.
//
// The leading letter is CAPTURED and put back rather than matched by a lookbehind,
// which is the obvious way to write this. Lookbehind is a parse-time syntax error on
// Safari before 16.4 — not a failed match, a SyntaxError that takes the whole chunk
// down with it, so an old iPhone would get a blank editor rather than a straight
// apostrophe. \p{L} and lookahead are both fine back to Safari 11.1. Consuming the
// letter costs nothing: "a'b'c" still curls both, because the engine resumes at "b",
// which is itself the letter the second match needs.
const LETTER_FLANKED_APOSTROPHE = /(\p{L})'(?=\p{L})/gu;

const RIGHT_SINGLE_QUOTE = "’";
const CURL_REPLACEMENT = `$1${RIGHT_SINGLE_QUOTE}`;

// Whitespace, EXCEPT the ideographic space (U+3000). \s matches U+3000, so the naive
// collapse rewrites the Japanese name "山田　太郎" to use a Latin space — a real edit
// to the text, not a tidy, and one the user can't undo without a full-width space key.
// It reads as deliberate spacing in CJK the way a hyphen does in English, so INSIDE a
// value it is content and stays exactly where it was put.
//
// The trim below is a plain .trim(), which does NOT carry the exception, and that
// asymmetry is deliberate. Between two names the character is doing work; on the front
// or back of one it is the same stray keystroke any other space would be. Exempting it
// there too meant a lone U+3000 came back non-empty — enough to skip normalizeFolder's
// "Folder" fallback and to store a blank-looking brand, so a folder could end up named
// something that renders as nothing at all.
const COLLAPSIBLE_SPACE = /[^\S　]+/g;

/**
 * A human-typed string → the form that gets stored.
 *
 * Never grows the string (the curl is one code unit for one), so a caller may slice to
 * its cap first and still hold a result within that cap — which is how ops.ts applies
 * it, so a cut that lands mid-space doesn't leave the space behind.
 *
 * Single-line by definition: newlines collapse to spaces along with every other run of
 * collapsible whitespace. Every field this runs on is a one-line field — a name, a
 * title, a note — each backed by an <input> that cannot hold a line break anyway. For
 * the one field that can, use tidyProse.
 */
export function tidyText(raw: string): string {
  return raw
    .replace(INVISIBLE, "")
    .replace(LETTER_FLANKED_APOSTROPHE, CURL_REPLACEMENT)
    .replace(COLLAPSIBLE_SPACE, " ")
    .trim();
}

// Horizontal whitespace only — a newline is content here, and U+3000 keeps the
// exception it has above. Spaces hugging a line break go with it, so a wrapped
// paragraph doesn't keep the trailing spaces its source had.
const HORIZONTAL_SPACE = /[^\S\n　]+/g;
const SPACE_AROUND_BREAK = / *\n */g;
const LINE_ENDINGS = /\r\n?/g;

/**
 * The same pass, for the one field that is allowed to be more than one line.
 *
 * Only the list description qualifies. It has no editor anywhere in the app — it
 * arrives from a LighterPack import or a JSON backup — and it is the only text here
 * that can legitimately hold paragraphs. Running tidyText on it flattened those
 * paragraphs permanently, so a backup no longer round-tripped, and it bought nothing
 * on screen: the field renders in a <p>, which collapses whitespace itself.
 *
 * The apostrophe half is worth having, though, which is the whole reason this exists.
 * The description renders directly beneath the title, and a title reading
 * "Ryan’s Timberline" above a line reading "Ryan's notes" is the exact mismatch the
 * tidy is for. So: curl and strip like everywhere else, tidy horizontal runs, and
 * leave every line break exactly where the author put it.
 */
export function tidyProse(raw: string): string {
  return raw
    .replace(INVISIBLE, "")
    .replace(LETTER_FLANKED_APOSTROPHE, CURL_REPLACEMENT)
    .replace(LINE_ENDINGS, "\n")
    .replace(HORIZONTAL_SPACE, " ")
    .replace(SPACE_AROUND_BREAK, "\n")
    .trim();
}

// Every apostrophe spelling folded to the straight one. The curly mark this file
// produces, the curly OPENING mark, and the modifier letter that some keyboards emit.
const ANY_APOSTROPHE = /[‘’ʼ]/g;

/**
 * Both apostrophe spellings folded together, for LITERAL substring matching.
 *
 * The fuzzy paths don't need this — foldForSearch() strips every non-alphanumeric, so
 * the catalog ranker and the vault ranker already match "Arc'teryx" against
 * "Arc’teryx". The three plain `.includes()` filters do: the vault list, the saved-list
 * switcher and the vault category picker all narrow a list you are LOOKING at, by
 * literal substring, on purpose. Once tidyText stores "Ryan’s repair kit", a user
 * typing the apostrophe their keyboard makes would get zero results for text they can
 * see on screen.
 *
 * Folds rather than tidies, because a query is read mid-keystroke: tidyText("Ryan'")
 * leaves the apostrophe straight (nothing follows it yet), so the row would vanish for
 * exactly as long as it takes to type the next letter. Both sides fold, so neither
 * spelling can hide the other.
 */
export function foldApostrophes(raw: string): string {
  return raw.replace(ANY_APOSTROPHE, "'");
}
