// Money — parsing what someone types and formatting it back.
//
// Costs are stored as INTEGER CENTS, never floats, for the same reason weights are
// stored as integer milligrams: 0.1 + 0.2 is not 0.3, and a gear list that quietly
// loses a cent per item is worse than one that refuses the input.
//
// Pure and framework-agnostic so the client, the exporters and the tests all agree.

/** Currencies offered in the picker. Deliberately short — this is a hiking app,
 *  not a bureau de change; the list covers where the gear catalog's brands sell.
 *  Any ISO code already stored still formats correctly, it just isn't offered. */
export const CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "CHF",
  "JPY",
  "SEK",
  "NOK",
] as const;

export type Currency = (typeof CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "USD";

/** Narrow an arbitrary stored/By-the-wire string to a currency we offer, falling
 *  back to the default. Used on both sides of the wire so a junk value can never
 *  reach Intl (which throws on an invalid code). */
export function normalizeCurrency(raw: unknown): Currency {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return (CURRENCIES as readonly string[]).includes(code) ? (code as Currency) : DEFAULT_CURRENCY;
}

/** Upper bound on a stored price: $1,000,000. Anything past this is a typo or an
 *  attempt to make a total unreadable, not a piece of hiking gear. */
export const PRICE_CENTS_MAX = 100_000_000;

/**
 * Parse what a person types into integer cents, or null if it isn't a number.
 *
 * Deliberately forgiving about decoration — a leading currency symbol, spaces,
 * and thousands separators are all things people paste in. It is NOT forgiving
 * about ambiguity: an empty string returns null (the caller treats that as
 * "clear the price"), and a negative is clamped to zero rather than guessed at.
 *
 * Separators: whichever of `.` or `,` appears LAST is the decimal separator, and
 * the other is a thousands separator. That one rule covers both conventions —
 * "1,299.50" and "1.299,50" are the same number — where "a period means US
 * format" does not (it reads the European form as 1.29950 and rounds it to a
 * penny). A lone comma is decimal only when exactly two digits follow it at the
 * end ("12,50" → 1250); otherwise it's thousands ("1,299" → 129900).
 */
export function parseMoneyInput(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  // strip currency symbols/letters and spaces, keep digits and separators
  let cleaned = trimmed.replace(/[^\d.,-]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;

  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // both present: the later one is the decimal point, the earlier is grouping
    cleaned =
      lastComma > lastDot
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0 && /,\d{2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/,(\d{2})$/, ".$1");
  }
  cleaned = cleaned.replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.min(PRICE_CENTS_MAX, Math.max(0, Math.round(value * 100)));
}

/** Cents → a localised currency string ("$129.00"). Falls back to a plain code +
 *  amount if the runtime doesn't know the currency, so this can never throw into
 *  a render. */
export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY): string {
  const code = normalizeCurrency(currency);
  const amount = (cents || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      // whole amounts read better without ".00" in a scannable column, but keep
      // cents whenever they're actually there
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}
