// One rule for a number a person typed, checked in every field that reads one.
//
// Each field has its own scanner (a weight can be a compound, a distance can be a pasted
// stats line, a price carries a symbol), and each used to carry its own idea of what a
// comma or a space inside the number meant. The same text came out as 2 ml of water and
// 2,000 g of tent. So the table below runs one input through every field's parser and
// states the number each must read.

import { describe, expect, it } from "vitest";
import { csvToListData } from "../shared/exporters/csv";
import { parsePriceInput, PRICE_MAX_CENTS } from "../shared/money";
import { parseBodyWeightG, parseDistanceM, splitAmount } from "../shared/trailDistance";
import { parseNumberToken } from "../shared/typedNumber";
import { parseVolumeMl } from "../shared/water";
import { entryUnitFromInput, parseDecimal, parseKcal, parseWeightInput, toMg } from "../shared/weights";

// What each field makes of a BARE number, as the number it read (null = refused):
//   weight   the weight field on a gram list
//   cell     a number cell in an imported file
//   distance the trail distance field on a km list (refuses nothing-or-less and over 10,000 km)
//   amount   splitAmount, under the water and body weight fields (refuses nothing-or-less)
//   water    the water field, where a bare number is litres
//   price    the price field
//   kcal     the calories field (whole numbers)
//   csvKcal  a calories cell in an imported file (whole numbers, kept only above zero)
const read = {
  weight: (s: string) => parseWeightInput(s, "g"),
  cell: (s: string) => parseDecimal(s),
  distance: (s: string) => parseDistanceM(s, "km"),
  amount: (s: string) => splitAmount(s)?.n ?? null,
  water: (s: string) => parseVolumeMl(s),
  price: (s: string) => parsePriceInput(s)?.cents ?? null,
  kcal: (s: string) => parseKcal(s),
  csvKcal: (s: string) =>
    csvToListData(`name,weight,unit,calories,consumable\nBars,60,g,"${s}",1`).items[0]!.kcal ?? null,
};

// The stored form of the number each field read, by the field's own conversion.
const stored = {
  weight: (n: number) => toMg(n, "g"),
  cell: (n: number) => n,
  distance: (n: number) => Math.round(n * 1000),
  amount: (n: number) => n,
  water: (n: number) => n * 1000,
  price: (n: number) => Math.min(PRICE_MAX_CENTS, Math.round(n * 100)),
  kcal: (n: number) => n,
  csvKcal: (n: number) => n,
};

type Field = keyof typeof read;
const FIELDS = Object.keys(read) as Field[];
const NO = null;

/** One input, and the number every field must read from it: `all`, then the fields that differ. */
type Row = [input: string, all: number | null, except?: Partial<Record<Field, number | null>>];

const TABLE: Row[] = [
  // ---- these read as they always did ----
  ["1234", 1234],
  ["820", 820],
  ["1.5", 1.5, { kcal: 2, csvKcal: 2 }],
  ["0.5", 0.5, { kcal: 1, csvKcal: 1 }],
  [".9", 0.9, { kcal: 1, csvKcal: 1 }],
  ["12.25", 12.25, { kcal: 12, csvKcal: 12 }],
  // a comma with one or two digits behind it is the decimal point
  ["1,5", 1.5, { kcal: 2, csvKcal: 2 }],
  ["1,50", 1.5, { kcal: 2, csvKcal: 2 }],
  ["12,50", 12.5, { kcal: 13, csvKcal: 13 }],
  ["0,5", 0.5, { kcal: 1, csvKcal: 1 }],
  ["1,23", 1.23, { kcal: 1, csvKcal: 1 }],
  ["72,5", 72.5, { kcal: 73, csvKcal: 73 }],
  // both kinds: the last is the decimal point
  ["1,234.56", 1234.56, { kcal: 1235, csvKcal: 1235 }],
  ["1.234,56", 1234.56, { kcal: 1235, csvKcal: 1235 }],

  // ---- a comma or a space with exactly three digits behind it groups thousands ----
  ["1,234", 1234],
  ["1,299", 1299],
  ["2,000", 2000],
  ["1,500", 1500],
  ["3,159", 3159],
  ["1 234", 1234],
  ["12 000", 12000, { distance: NO }], // 12,000 km is past the longest route there is
  ["1 234,5", 1234.5, { kcal: 1235, csvKcal: 1235 }],
  ["1 234.5", 1234.5, { kcal: 1235, csvKcal: 1235 }],
  ["1,234,567", 1234567, { distance: NO, price: 1_000_000 }], // the price ceiling
  ["1.234.567", 1234567, { distance: NO, price: 1_000_000 }], // a point can't come twice
  // …and with any other count behind it, the comma is the decimal point
  ["1,2345", 1.2345, { price: 1.23, kcal: 1, csvKcal: 1 }],
  [",9", 0.9, { kcal: 1, csvKcal: 1 }],
  // nothing groups after a leading zero, or after more than three digits
  ["0,750", 0.75, { kcal: 1, csvKcal: 1 }],
  ["1234,567", 1234.567, { price: 1234.57, kcal: 1235, csvKcal: 1235 }],

  // ---- a lone dot is the decimal point, except in a price or a whole number ----
  ["1.234", 1.234, { price: 1234, kcal: 1234, csvKcal: 1234 }],
  ["0.250", 0.25, { kcal: 0, csvKcal: NO }],

  // ---- two numbers stay two ----
  // the weight, cell and distance fields take the first; the price field runs its
  // digits together, as it always has
  ["5 10", NO, { weight: 5, cell: 5, distance: 5, price: 510, csvKcal: 5 }],

  // ---- a separator that comes twice groups, so it must group in threes ----
  ["1,2,3", NO, { cell: Number.NaN }],
  ["1..5", NO, { cell: Number.NaN }],

  // ---- a minus sign, and no number at all: each field as it always was ----
  ["-5", NO, { weight: -5, cell: -5, price: 5, kcal: -5 }],
  ["", NO, { cell: Number.NaN }],
  ["   ", NO, { cell: Number.NaN }],
  ["lots", NO, { cell: Number.NaN }],
];

describe("a typed number reads the same in every field", () => {
  for (const [input, all, except = {}] of TABLE) {
    it(`${JSON.stringify(input)}`, () => {
      const got: Record<string, number | null> = {};
      const want: Record<string, number | null> = {};
      for (const field of FIELDS) {
        const n = field in except ? except[field]! : all;
        got[field] = read[field](input);
        want[field] = n == null ? null : stored[field](n);
      }
      expect(got).toEqual(want);
    });
  }
});

describe("the same rule, with each field's own units and shapes around it", () => {
  it("weight: unit words, grouped thousands, and compounds", () => {
    const cases: [string, number | null][] = [
      ["820 g", 820_000],
      ["820 grams", 820_000],
      ["1.36kg", 1_360_000],
      ["1,5 kg", 1_500_000],
      ["1.234 kg", 1_234_000],
      ["1,360 g", 1_360_000],
      ["2,000 g", 2_000_000],
      ["12 000 g", 12_000_000],
      ["1 234 g", 1_234_000],
      ["1,2345 kg", 1_234_500],
      ["0,750 kg", 750_000],
      [".9oz", toMg(0.9, "oz")],
      ["2 lb 3 oz", 992_233],
      ["2lb3oz", 992_233],
      ["1 kg 500 g", 1_500_000],
      ["32.5 oz (921 g)", toMg(32.5, "oz")],
      ["size 2 / 400 g", 400_000],
      ["850 - 900 g", 900_000],
      ["-5 g", -5_000],
      ["5 pretzels", null],
    ];
    for (const [input, mg] of cases) expect([input, parseWeightInput(input, "g")]).toEqual([input, mg]);
    // a grouped figure is still one figure with one unit
    expect(entryUnitFromInput("12 000 g")).toBe("g");
    expect(entryUnitFromInput("2 lb 3 oz")).toBeNull();
  });

  it("water: a grouped volume is the volume it says", () => {
    const cases: [string, number | null][] = [
      ["2,000 ml", 2000],
      ["1,500 ml", 1500],
      ["1 500 ml", 1500],
      ["1500 ml", 1500],
      ["1,5 l", 1500],
      ["0,75 l", 750],
      ["0,750 l", 750],
      ["1.5L", 1500],
      ["1.500 ml", 1.5],
      ["1cl", 10],
      ["-1 l", null],
      ["0", null],
    ];
    for (const [input, ml] of cases) expect([input, parseVolumeMl(input)]).toEqual([input, ml]);
    expect(parseVolumeMl("32 fl. oz")).toBeCloseTo(946.352, 2);
  });

  it("distance: typed, and pasted off a stats line", () => {
    const cases: [string, number | null][] = [
      [",9 km", 900],
      [".9 km", 900],
      ["12,5 km", 12_500],
      ["1,2345 km", Math.round(1.2345 * 1000)],
      ["1.234,56 km", 1_234_560],
      ["1,234.56 km", 1_234_560],
      ["1,200 m", 1200],
      ["12 000 m", 12_000],
      ["1 234 km", 1_234_000],
      ["3,159 ft", 963],
      ["7.5 mi • 3,159 ft • Out & back", 12_070],
      ["3,159 ft • 7.5 mi", 12_070],
      // a comma after a word is punctuation, not a decimal point
      ["Out & back,12 km", 12_000],
      ["-5 km", null],
      ["10 furlongs", null],
    ];
    for (const [input, m] of cases) expect([input, parseDistanceM(input, "km")]).toEqual([input, m]);
    expect(parseDistanceM("12 000 m", "mi")).toBe(12_000);
  });

  it("body weight: the same amount, inside its bounds", () => {
    expect(parseBodyWeightG("72,5", "kg")).toBe(72_500);
    expect(parseBodyWeightG("72.5 kg", "lb")).toBe(72_500);
    expect(parseBodyWeightG("160 lb", "kg")).toBe(72_575);
    expect(parseBodyWeightG("1,234", "kg")).toBeNull(); // 1,234 kg is not a person
    expect(parseBodyWeightG("-70", "kg")).toBeNull();
  });

  it("price: symbols and codes around the number, and a lone dot as thousands", () => {
    const cases: [string, number | null, string?][] = [
      ["$1,299.00", 129_900, "USD"],
      ["1.299,00 €", 129_900, "EUR"],
      ["£62.50", 6_250, "GBP"],
      ["1.299", 129_900],
      ["1 299,50", 129_950],
      ["CAD 12,50", 1_250, "CAD"],
      [".99", 99],
      ["approx. $399", 39_900, "USD"],
      ["free", null],
    ];
    for (const [input, cents, currency] of cases) {
      const price = parsePriceInput(input);
      expect([input, price?.cents ?? null, price?.currency]).toEqual([input, cents, currency]);
    }
  });

  it("kcal: whole numbers, so a fraction rounds as it does when stored", () => {
    const cases: [string, number | null][] = [
      ["2,700", 2700],
      [" 1 350 ", 1350],
      ["12 000", 12_000],
      ["1,5", 2],
      ["12.5", 13],
      ["-5", -5],
      ["12abc", null],
      ["1e3", null],
      ["13 50", null],
      [",", null],
    ];
    for (const [input, kcal] of cases) expect([input, parseKcal(input)]).toEqual([input, kcal]);
  });

  it("a file's cells: the leading figure, by the same rule", () => {
    expect(parseDecimal("538 g")).toBe(538);
    expect(parseDecimal("1,360")).toBe(1360);
    expect(parseDecimal("12 000")).toBe(12_000);
    expect(parseDecimal("1.234,5")).toBe(1234.5);
    expect(parseDecimal("g 538")).toBeNaN();
    expect(parseDecimal("+5")).toBe(5);
    const data = csvToListData(
      ["name,weight,unit,calories,consumable", 'Bars,60,g,"1,200",1', 'Gel,30,g,"1,5",1', "Mix,90,g,450 kcal,1", "Salt,5,g,0,1"].join("\n"),
    );
    expect(data.items.map((i) => i.kcal)).toEqual([1200, 2, 450, undefined]);
  });
});

describe("parseNumberToken — the rule itself", () => {
  it("groups thousands on a comma or a space with exactly three digits behind it", () => {
    expect(parseNumberToken("1,234")).toBe(1234);
    expect(parseNumberToken("12 000")).toBe(12_000);
    expect(parseNumberToken("1 234 567")).toBe(1_234_567);
    expect(parseNumberToken("1,234,567")).toBe(1_234_567);
    // the spaces a number formatter writes
    expect(parseNumberToken("12\u00a0000")).toBe(12_000);
    expect(parseNumberToken("12\u202f000")).toBe(12_000);
  });

  it("otherwise takes the last separator as the decimal point", () => {
    expect(parseNumberToken("1,5")).toBe(1.5);
    expect(parseNumberToken(",9")).toBe(0.9);
    expect(parseNumberToken("1,2345")).toBe(1.2345);
    expect(parseNumberToken("1.234,56")).toBe(1234.56);
    expect(parseNumberToken("1,234.56")).toBe(1234.56);
    expect(parseNumberToken("1 234,567")).toBe(1234.567);
    expect(parseNumberToken("1.234")).toBe(1.234);
    expect(parseNumberToken("0,750")).toBe(0.75);
  });

  it("reads a lone dot with three digits behind it as thousands only where asked", () => {
    expect(parseNumberToken("1.299", { dotThousands: true })).toBe(1299);
    expect(parseNumberToken("1.29", { dotThousands: true })).toBe(1.29);
    expect(parseNumberToken("0.250", { dotThousands: true })).toBe(0.25);
    expect(parseNumberToken("1.299,50", { dotThousands: true })).toBe(1299.5);
  });

  it("rounds to a whole number only where asked", () => {
    expect(parseNumberToken("1,5", { whole: true })).toBe(2);
    expect(parseNumberToken("-1,5", { whole: true })).toBe(-2);
    expect(parseNumberToken("2,700", { whole: true })).toBe(2700);
  });

  it("reads a whole-number field's lone dot with three digits behind it as thousands", () => {
    // nobody means 2.7 calories: "2.700" is how half of Europe writes 2,700
    expect(parseNumberToken("2.700", { whole: true })).toBe(2700);
    expect(parseNumberToken("2.7", { whole: true })).toBe(3);
    expect(parseNumberToken("0.700", { whole: true })).toBe(1);
  });

  it("keeps a sign, drops a trailing separator, and refuses what isn't one number", () => {
    expect(parseNumberToken("-5")).toBe(-5);
    expect(parseNumberToken("850,")).toBe(850);
    expect(parseNumberToken("12.")).toBe(12);
    for (const not of ["", " ", ",", "-", "5 10", "12 0000", "1, 234", "12abc", "1e3", "1..5", "1,,5", "1,2,3", "1,234,5", "1.23.4", "1 23"]) {
      expect([not, parseNumberToken(not)]).toEqual([not, Number.NaN]);
    }
  });
});
