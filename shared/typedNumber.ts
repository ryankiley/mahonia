// A number a person typed — the one rule for what a comma, a dot or a space inside it means.
//
// Every field that reads a typed number (weight, distance, water, body weight, price,
// calories, a number cell in an imported file) hands its number here, so "1,234" can't be
// twelve hundred in one field and one and a bit in the next. Each field keeps its own
// scanner, because what surrounds the number differs (a compound weight, a pasted stats
// line, a currency symbol), but builds it from TYPED_NUMBER below so the scanner finds
// exactly what this rule reads.
//
//   A comma or a space with exactly three digits behind it groups thousands:
//     "1,234" is 1234, "12 000" is 12000, "1,234,567" is 1234567.
//   Otherwise the last separator is the decimal point:
//     "1,5" is 1.5, ",9" is 0.9, "1,2345" is 1.2345, "1.234,56" is 1234.56.
//
// Thousands come in groups after one to three digits that don't open with a zero, so
// "0,750" is three quarters and "1234,567" has a decimal comma. A separator that comes
// twice can only be grouping, since a number has one decimal point.
//
// Imports nothing, so any module in shared/ can reach it without a cycle.

/** What one field asks of the rule beyond the common reading. */
export interface NumberRule {
  /** A lone dot with exactly three digits behind it groups thousands ("1.299" is 1299).
   *  For prices: nobody quotes one to a tenth of a cent, and "1.299" is how half of
   *  Europe writes thirteen hundred. */
  dotThousands?: boolean;
  /** Round to a whole number. For calories, which are stored whole. */
  whole?: boolean;
}

// The spaces that group thousands: the plain one, and the non-breaking pair number
// formatters write. A tab or a line break separates two numbers.
const GAP = String.raw`[ \u00a0\u202f]`;

// Thousands written with spaces: "12 000", "1 234 567". Exact groups of three only, so
// "5 10" and "12 0000" stay two numbers.
const SPACED = String.raw`[1-9]\d{0,2}(?:${GAP}\d{3}(?!\d))+`;

/**
 * Regex source for one typed number without its sign: digits with any mix of ',' and
 * '.', led by a space-grouped figure or a plain digit, or a separator-led fraction
 * (".9", ",9"). What a scanner built on this captures, parseNumberToken reads.
 */
export const TYPED_NUMBER = String.raw`(?:(?:${SPACED}|\d)[\d.,]*|[.,]\d+)`;

/**
 * TYPED_NUMBER without the space grouping, for a scanner that splits a number off the
 * words before it: there a space-grouped figure would take a name's own trailing number
 * ("iPhone 15 171 g" is not fifteen kilos).
 */
export const UNSPACED_NUMBER = String.raw`(?:\d[\d.,]*|[.,]\d+)`;

// What stands before a lone thousands separator. Digits only, so a head that already
// holds a separator is not one: that is what makes the last of two kinds the decimal point.
const GROUP_HEAD = /^[1-9]\d{0,2}$/;

// The whole-number part once the decimal point is set aside: plain digits, or one kind of
// separator grouping exact threes. "1,2,3" and "1..5" are typos, not 123 and 15.
const WHOLE_PART = /^(?:\d*|[1-9]\d{0,2}([., ])\d{3}(?:\1\d{3})*)$/;

/**
 * One number token → its value, or NaN when the token isn't one number. Takes a
 * leading sign and ignores a trailing separator ("850," in a list of figures).
 */
export function parseNumberToken(token: string, rule: NumberRule = {}): number {
  const m = /^([-+]?)([\d., ]*\d)[.,]*$/.exec(token.trim().replace(/[\u00a0\u202f]/g, " "));
  if (!m) return Number.NaN;
  const t = m[2]!;

  // The last separator is the decimal point unless it groups. A space always groups, and
  // so does a separator that comes twice; a comma (or a price's dot) that comes once
  // groups with exactly three digits behind it and a group's head before it. Whatever
  // groups must group in threes (WHOLE_PART), or the token is not one number.
  const at = Math.max(t.lastIndexOf(","), t.lastIndexOf("."), t.lastIndexOf(" "));
  const last = t[at];
  let decimal = false;
  if (last && last !== " " && t.indexOf(last) === at) {
    const groups = t.length - at - 1 === 3 && GROUP_HEAD.test(t.slice(0, at));
    decimal = last === "," ? !groups : !(groups && rule.dotThousands);
  }

  const whole = decimal ? t.slice(0, at) : t;
  if (!WHOLE_PART.test(whole)) return Number.NaN;
  const n = Number(decimal ? `${whole.replace(/\D/g, "")}.${t.slice(at + 1)}` : whole.replace(/\D/g, ""));
  const value = rule.whole ? Math.round(n) : n;
  return m[1] === "-" && value !== 0 ? -value : value;
}
