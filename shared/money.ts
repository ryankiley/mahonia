// What a piece of gear cost — free text in, whole cents out.
//
// The counterpart to parseWeightInput: you buy gear labelled "$399" or "£62.50",
// and a field that only accepts bare digits makes you strip the symbol before it
// will listen. So the symbol is read rather than rejected, and what it says about
// the currency is kept alongside the number.
//
// Pure and framework-agnostic, like the rest of shared/ — the vault's edit dialog
// parses with it, /gear and the exporters format with it, and the rules below are
// pinned by tests/money.test.ts rather than by clicking a form.

/** Ceiling on a stored price. `price_cents` is a plain integer column, so an
 *  unbounded value is an overflow rather than a big number; a million of any
 *  currency is well past the point where a typo is likelier than a purchase. */
export const PRICE_MAX_CENTS = 100_000_000;

/** The symbols worth reading, and what each says. Deliberately short: these are the
 *  ones that appear on the gear pages this app links to. "$" is genuinely ambiguous
 *  (USD/CAD/AUD/NZD…) and resolves to USD — someone who means Canadian dollars types
 *  "CAD 399", which the code branch below reads. */
const SYMBOL_CURRENCY: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
  "₹": "INR",
};

/** A price as it's stored: whole cents, plus the currency when the input said one. */
export interface Price {
  cents: number;
  /** ISO 4217, when it could be read off the input. Absent = a bare number, which
   *  renders as a bare number — guessing the reader's currency would be worse. */
  currency?: string;
}

/** The currency a typed price declares, or absent. A symbol anywhere wins; failing
 *  that, a three-letter token IN CAPITALS is read as a code. The capitals are the
 *  whole guard: "USD 399" is someone naming a currency, whereas a lowercase triple
 *  is as likely to be a word ("two 99") and would file junk in the column. */
function currencyOf(s: string): string | undefined {
  for (const [symbol, code] of Object.entries(SYMBOL_CURRENCY)) {
    if (s.includes(symbol)) return code;
  }
  return s.match(/\b([A-Z]{3})\b/)?.[1];
}

/**
 * Read a typed price. Returns null when the text holds no number at all, so a
 * caller can tell a typo from a cleared field — which it checks for itself, the
 * same split parseWeightInput's callers make.
 *
 * The separator rule is the standard heuristic, because "1,299" is a thousand-odd
 * dollars in one locale and one dollar twenty-nine in another: with both kinds
 * present the LAST is the decimal point, and a lone separator with exactly three
 * digits behind it is a thousands group. That reads "1,299.00", "1.299,00", "1299",
 * "12,50" and "1,299" the way they were meant; a four-figure price written with a
 * decimal comma and no cents is not a thing anyone types.
 */
export function parsePriceInput(raw: string): Price | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const currency = currencyOf(s);

  // everything that isn't a digit or a separator goes — symbols, codes, spaces
  const digits = s.replace(/[^\d.,]/g, "");
  if (!/\d/.test(digits)) return null;

  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  const both = lastDot >= 0 && lastComma >= 0;
  const at = Math.max(lastDot, lastComma);
  const grouped = at >= 0 && !both && digits.length - at - 1 === 3;
  const decimal = at >= 0 && !grouped;

  const whole = (decimal ? digits.slice(0, at) : digits).replace(/[.,]/g, "");
  const frac = decimal ? digits.slice(at + 1).replace(/\D/g, "") : "";

  const cents = Number(whole || "0") * 100 + Number(`${frac}00`.slice(0, 2));
  if (!Number.isFinite(cents) || cents < 0) return null;
  return { cents: Math.min(PRICE_MAX_CENTS, Math.round(cents)), currency };
}

/** What a set of gear cost, when that question has one honest answer. */
export interface PriceTotal {
  cents: number;
  /** The currency every priced row agreed on, or absent when none stated one. */
  currency?: string;
  /** How many rows carried a price — the figure's own denominator. */
  counted: number;
}

/**
 * Add up what you paid for a set of gear.
 *
 * Returns null when the rows name MORE THAN ONE currency, and that is the whole
 * design: a sum across two currencies is not a smaller truth, it is a wrong number,
 * and stamping the majority's symbol on it would be a wrong number that looks
 * right. A vault that mixes them shows no total rather than a bad one.
 *
 * A price with no currency (a bare number typed into the dialog) agrees with
 * everything — it says "unstated", not "a different one" — so a vault where one row
 * says "$399" and the rest say "62" totals in dollars. That is the common shape:
 * one person, one currency, a symbol typed once.
 *
 * Rows with no price at all are simply not counted; `counted` is how many were, so
 * a caller can decide whether a figure standing for three rows out of ninety is
 * worth showing.
 */
export function sumPrices(
  rows: readonly { priceCents?: number; currency?: string }[],
): PriceTotal | null {
  let cents = 0;
  let counted = 0;
  let currency: string | undefined;
  for (const row of rows) {
    if (typeof row.priceCents !== "number" || row.priceCents <= 0) continue;
    if (row.currency) {
      if (currency && row.currency !== currency) return null;
      currency = row.currency;
    }
    cents += row.priceCents;
    counted++;
  }
  return counted ? { cents, currency, counted } : null;
}

/**
 * A stored price as it reads on screen and in an export.
 *
 * Intl does the currency's own placement and separators ("$399.00", "399,00 €"),
 * which is what makes a price look local rather than American-with-a-symbol. A code
 * Intl won't take throws rather than falling back, so the bare number is the catch —
 * the same shape a price with no currency at all takes.
 */
export function formatPrice(cents: number, currency?: string): string {
  const value = Math.max(0, Math.round(cents)) / 100;
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency.toUpperCase(),
      }).format(value);
    } catch {
      /* not a currency Intl knows — fall through to the plain number */
    }
  }
  return value.toFixed(2);
}
