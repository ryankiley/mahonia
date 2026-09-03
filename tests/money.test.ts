// What a typed price reads as, and what a stored one renders as.
//
// Plain node: shared/money.ts exists as its own module precisely so the separator
// heuristic — the part that is invisible until someone in Berlin types "1.299,00"
// and buys a €1.29 tent — is pinned by a test rather than by a form.

import { describe, expect, it } from "vitest";
import { PRICE_MAX_CENTS, formatPrice, parsePriceInput, sumPrices } from "../shared/money";

describe("parsePriceInput — reading a price the way it was typed", () => {
  it("takes a bare number as whole units", () => {
    expect(parsePriceInput("399")).toEqual({ cents: 39_900, currency: undefined });
  });

  it("takes cents after a decimal point", () => {
    expect(parsePriceInput("62.50")?.cents).toBe(6_250);
    expect(parsePriceInput("0.5")?.cents).toBe(50);
  });

  it("reads the currency off a symbol, wherever it sits", () => {
    expect(parsePriceInput("$399")).toEqual({ cents: 39_900, currency: "USD" });
    expect(parsePriceInput("£62.50")).toEqual({ cents: 6_250, currency: "GBP" });
    expect(parsePriceInput("399 €")).toEqual({ cents: 39_900, currency: "EUR" });
  });

  it("reads a three-letter code, but only in capitals", () => {
    // capitals are the whole guard against filing a word in the currency column
    expect(parsePriceInput("CAD 399")?.currency).toBe("CAD");
    expect(parsePriceInput("cad 399")?.currency).toBeUndefined();
  });

  it("treats a lone separator with three digits behind it as thousands", () => {
    expect(parsePriceInput("1,299")?.cents).toBe(129_900);
    expect(parsePriceInput("1.299")?.cents).toBe(129_900);
  });

  it("treats a lone separator with fewer than three digits behind it as decimal", () => {
    // the European decimal comma — "12,50" is twelve fifty, not twelve hundred
    expect(parsePriceInput("12,50")?.cents).toBe(1_250);
  });

  it("lets the LAST separator decide when both kinds appear", () => {
    expect(parsePriceInput("1,299.00")?.cents).toBe(129_900);
    expect(parsePriceInput("1.299,00")?.cents).toBe(129_900);
  });

  it("returns null for text holding no number, and for nothing at all", () => {
    expect(parsePriceInput("free")).toBeNull();
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput("   ")).toBeNull();
  });

  it("caps at the column's ceiling rather than overflowing it", () => {
    expect(parsePriceInput("99999999999")?.cents).toBe(PRICE_MAX_CENTS);
  });
});

describe("formatPrice", () => {
  it("renders a known currency in its own conventions", () => {
    // the exact string is Intl's and locale-dependent — what's pinned is that the
    // currency reaches it, rather than the number arriving bare
    expect(formatPrice(39_900, "USD")).toMatch(/399/);
    expect(formatPrice(39_900, "USD")).not.toBe("399.00");
  });

  it("falls back to a plain number for no currency, and for one Intl won't take", () => {
    expect(formatPrice(39_900)).toBe("399.00");
    expect(formatPrice(39_900, "ZZZZ")).toBe("399.00");
  });

  it("round-trips what the edit dialog prefills", () => {
    // the dialog prefills FORMATTED and reparses on change — a lossy trip here
    // would re-price gear nobody touched
    for (const [cents, code] of [
      [39_900, "USD"],
      [6_250, "GBP"],
      [129_900, "EUR"],
    ] as const) {
      expect(parsePriceInput(formatPrice(cents, code))).toEqual({ cents, currency: code });
    }
  });
});

describe("sumPrices — what a set of gear cost", () => {
  it("adds the rows that carry a price and ignores the rest", () => {
    expect(sumPrices([{ priceCents: 39_900 }, {}, { priceCents: 6_250 }])).toEqual({
      cents: 46_150,
      currency: undefined,
      counted: 2,
    });
  });

  it("labels the total when the rows state a currency", () => {
    expect(sumPrices([{ priceCents: 100, currency: "GBP" }])?.currency).toBe("GBP");
  });

  it("lets a bare number ride along with a stated currency", () => {
    // "unstated", not "a different one" — the common shape is one person typing a
    // symbol once and bare numbers thereafter
    const total = sumPrices([{ priceCents: 39_900, currency: "USD" }, { priceCents: 100 }]);
    expect(total).toEqual({ cents: 40_000, currency: "USD", counted: 2 });
  });

  it("refuses a total across two currencies rather than inventing one", () => {
    // a sum of pounds and dollars isn't a rougher truth, it's a wrong number that
    // would wear whichever symbol won
    expect(
      sumPrices([
        { priceCents: 39_900, currency: "USD" },
        { priceCents: 6_250, currency: "GBP" },
      ]),
    ).toBeNull();
  });

  it("is absent when nothing carries a price", () => {
    expect(sumPrices([])).toBeNull();
    expect(sumPrices([{}, { priceCents: 0 }])).toBeNull();
  });
});
