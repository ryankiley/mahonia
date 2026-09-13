/**
 * A list typed as text, one item per line — the shape a packing list has in a phone's
 * Notes app, and what arrives when it is pasted into an item's name field.
 *
 * Two readings share this file because they have to agree. The trailing-weight rule
 * decides where a typed name ends and its weight begins ("Tent 540 g"), and it was born
 * in the name field; the paste splits text into lines and hands each line to that same
 * rule, so a pasted "Tent 540 g" makes exactly the row that typing it would have.
 *
 * Pure, so the pieces have plain tests (tests/pasteList.test.ts) and no component has
 * to be mounted to check what a line becomes.
 */

import { MAX_ITEMS, MAX_ITEM_NAME_LEN } from "./ops";
import { UNIT_ALIASES } from "./weights";

// The unit words the weight field itself reads (shared/weights, the one vocabulary), and
// its number token (".9 oz" is a weight there, so it is one here). Longest alias first,
// so "grams" is not read as "g" + "rams".
const UNIT_WORDS = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join("|");
const NUM = String.raw`(?:\d[\d.,]*|[.,]\d+)`;
// one figure with its unit, and any compounds after it ("2 lb 3 oz" is one weight; the
// field parser sums it, so the tail must hand all of it on)
const WEIGHT = String.raw`${NUM}\s?(?:${UNIT_WORDS})(?:\s${NUM}\s?(?:${UNIT_WORDS}))*`;

/**
 * A weight that trails a name: "Tent 540 g" → name "Tent", weight "540 g". Unitless
 * ("UL2", "Nalgene 1 L") stays in the name — the unit words are the field parser's own,
 * so a figure that would not parse there is not taken here.
 *
 * The weight may be set off by a dash, colon, comma or pipe, or wrapped in parentheses —
 * "Tent - 540 g", "Tent: 540 g", "Tent (540 g)" — because that is how people write a
 * weight after a name in a note. The parentheses come as a pair: "Quilt (20F, 600 g)" is
 * a parenthetical that merely ends in a weight, and stays whole. The regex runs on text
 * whose whitespace has been collapsed to single spaces (splitWeightTail), so every
 * quantifier here is bounded and a line of a thousand tabs costs nothing.
 */
export const WEIGHT_TAIL = new RegExp(
  // the separator's mark is lazy (`??`): "Bar ,9oz" is a bar at .9 oz, the comma the
  // field parser's decimal, before it is a bar at 9 oz behind a comma
  String.raw`(?:(?<sep> [-–—:,|]?? ?| ?[-–—:,|] ))(?:\((?<inParens>${WEIGHT})\)|(?<bare>${WEIGHT}))\s?$`,
  "i",
);

/** The name and, when one trails it, the weight — the weight as typed, for the row's
 *  own parser (parseWeightInput) to read against its unit. The name is trimmed, not
 *  tidied: the caller tidies, as it does for every name it stores. A split that would
 *  leave no name (": 540 g") is not a split: a weight with nothing in front of it is a
 *  name, as it always was when typed. A dash after a figure is a range ("Fuel 3 - 4 oz",
 *  "Bag 100 - 200 g"), not a separator, so that stays whole too. */
export function splitWeightTail(raw: string): { name: string; weight?: string } {
  const text = raw.replace(/\s+/g, " ").trim();
  const m = text.match(WEIGHT_TAIL);
  if (!m || m.index === undefined) return { name: text };
  const name = text.slice(0, m.index).trim();
  const sep = m.groups?.sep ?? "";
  if (!name) return { name: text };
  if (/[-–—]/.test(sep) && /\d$/.test(name)) return { name: text };
  return { name, weight: m.groups?.inParens ?? m.groups?.bare };
}

// What a line may start with that is not part of the name: the bullets and numbers a
// notes app puts in front of a list item, and the box of a checklist. Every marker wants
// a space after it, as Markdown and every notes app write them, so "-10F bag" and
// "*Optional* shoes" keep their first character. A number counts only with a space after
// it ("2.5 oz bar" is a bar, not item 2 named "5 oz bar"). Markers stack ("- [ ] Tent" is
// a bullet and then a box), so the pattern is applied until none is left. A line that is
// only its markers is blank.
const LINE_MARKER = /^(?:[-*•·◦▪–—](?:\s+|$)|\d{1,3}[.)](?:\s+|$)|\[[ xX]?\]\s*|[☐☑☒✓✔]\s*)/;

// Longer than any name the reducer will keep (MAX_ITEM_NAME_LEN), with room for a
// weight after it; what a pasted line carries past this is cut here rather than run
// through the tail rule, which is where the cost of a long line would be paid.
const MAX_LINE = MAX_ITEM_NAME_LEN + 40;

/**
 * A multi-line paste can never add more than this many rows to a list. Keeping one
 * clipboard gesture within that bound avoids allocating or walking an arbitrary number
 * of lines before the controller reaches its own item cap.
 */
export const MAX_PASTE_ROWS = MAX_ITEMS;

// Enough text for MAX_PASTE_ROWS longest useful lines plus their separators. This bounds
// the scan even when the clipboard starts with one enormous line or a sea of blank ones.
const MAX_PASTE_CHARS = MAX_PASTE_ROWS * (MAX_LINE + 1);

export interface ParsedPasteRows {
  rows: string[];
  /** More nonblank rows, or more clipboard text, followed the retained rows. */
  truncated: boolean;
}

const isLineBreak = (ch: string) => ch === "\r" || ch === "\n" || ch === "\u2028" || ch === "\u2029" || ch === "\v" || ch === "\f";

/**
 * The rows a pasted text makes: one per line that says anything, in order. Blank lines
 * are dropped, list markers are stripped, and the rest of the line is kept as typed
 * (weights included — see splitWeightTail for the next step).
 *
 * One line is not a list. The caller checks `length > 1` before treating a paste as
 * rows, so the browser's own paste keeps handling the single-line case.
 */
export function parsePasteRows(text: string): ParsedPasteRows {
  const rows: string[] = [];
  const input = text.slice(0, MAX_PASTE_CHARS);
  let truncated = input.length < text.length;
  let at = 0;
  // every line break a clipboard can carry: CRLF, CR, LF, and the Unicode line and
  // paragraph separators and the vertical tab a soft return becomes in some editors
  while (at < input.length) {
    let end = at;
    while (end < input.length && !isLineBreak(input[end]!)) end++;
    // Trim before the marker loop, not after it: a long run of list markers is no more
    // entitled to unbounded work than a long item name is.
    let row = input.slice(at, Math.min(end, at + MAX_LINE)).trim();
    for (let prev = ""; prev !== row; ) {
      prev = row;
      row = row.replace(LINE_MARKER, "").trim();
    }
    if (row) {
      if (rows.length < MAX_PASTE_ROWS) rows.push(row);
      else truncated = true;
    }
    if (end === input.length) break;
    // CRLF is one separator, not a CR row followed by a blank LF row.
    at = end + (input[end] === "\r" && input[end + 1] === "\n" ? 2 : 1);
  }
  return { rows, truncated };
}

/** The rows alone, for callers that do not need to explain an oversized paste. */
export function pasteRows(text: string): string[] {
  return parsePasteRows(text).rows;
}
