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

/**
 * A weight that trails a name: "Tent 540 g" → name "Tent", weight "540 g". Unitless
 * ("UL2", "Nalgene 1 L") stays in the name — the unit words are the same set the weight
 * field itself reads, so a figure that would not parse there is not taken here.
 *
 * The weight may be set off by a dash, colon, comma or pipe, or wrapped in parentheses —
 * "Tent - 540 g", "Tent: 540 g", "Tent (540 g)" — because that is how people write a
 * weight after a name in a note. Whitespace must sit on at least one side of the
 * separator: "Item 3-4 oz" is a range, not "Item 3" at 4 oz.
 */
export const WEIGHT_TAIL =
  /(?:\s+[-–—:,|]?\s*|\s*[-–—:,|]\s+)\(?(\d[\d.,]*\s*(?:kgs?|g|grams?|oz|ounces?|lbs?|pounds?))\)?\s*$/i;

/** The name and, when one trails it, the weight — the weight as typed, for the row's
 *  own parser (parseWeightInput) to read against its unit. The name is trimmed, not
 *  tidied: the caller tidies, as it does for every name it stores. */
export function splitWeightTail(raw: string): { name: string; weight?: string } {
  const m = raw.match(WEIGHT_TAIL);
  if (!m) return { name: raw.trim() };
  return { name: raw.slice(0, m.index).trim(), weight: m[1] };
}

// What a line may start with that is not part of the name: the bullets and numbers a
// notes app puts in front of a list item, and the box of a checklist. One marker per
// line, and a number counts only with a space after it ("2.5 oz bar" is a bar, not item
// 2 named "5 oz bar"). A line that is only its marker is blank.
const LINE_MARKER = /^(?:[-*•·◦▪–—]\s*|\d{1,3}[.)](?:\s+|$)|\[[ xX]?\]\s*|[☐☑☒✓✔]\s*)/;

/**
 * The rows a pasted text makes: one per line that says anything, in order. Blank lines
 * are dropped, a list marker is stripped, and the rest of the line is kept as typed
 * (weights included — see splitWeightTail for the next step).
 *
 * One line is not a list. The caller checks `length > 1` before treating a paste as
 * rows, so the browser's own paste keeps handling the single-line case.
 */
export function pasteRows(text: string): string[] {
  const rows: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const row = line.trim().replace(LINE_MARKER, "").trim();
    if (row) rows.push(row);
  }
  return rows;
}
