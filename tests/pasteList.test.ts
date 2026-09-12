// A list pasted as text, one item per line (shared/pasteList): what each line becomes,
// and where a typed name ends and its weight begins. The second rule was the name
// field's own before the paste existed; these cases pin the shapes it always read
// ("Tent 540 g", "UL2" staying whole) alongside the ones the paste added (a dash, a
// colon, parentheses between name and weight).
import { describe, expect, it } from "vitest";
import { pasteRows, splitWeightTail } from "../shared/pasteList";

describe("splitWeightTail", () => {
  it("takes a trailing weight off the name, as the field always has", () => {
    expect(splitWeightTail("Tent 540 g")).toEqual({ name: "Tent", weight: "540 g" });
    expect(splitWeightTail("Sleeping bag 32.5 oz")).toEqual({ name: "Sleeping bag", weight: "32.5 oz" });
    expect(splitWeightTail("Ti-Spork 17g")).toEqual({ name: "Ti-Spork", weight: "17g" });
    expect(splitWeightTail("Bear can 2 lbs")).toEqual({ name: "Bear can", weight: "2 lbs" });
    expect(splitWeightTail("Pack 1,200 g")).toEqual({ name: "Pack", weight: "1,200 g" });
  });

  it("leaves a figure that is not a weight in the name", () => {
    expect(splitWeightTail("Copper Spur HV UL2")).toEqual({ name: "Copper Spur HV UL2" });
    expect(splitWeightTail("Nalgene 1 L")).toEqual({ name: "Nalgene 1 L" });
    expect(splitWeightTail("5 pretzels")).toEqual({ name: "5 pretzels" });
    expect(splitWeightTail("Tent")).toEqual({ name: "Tent" });
  });

  // how a weight is written after a name in a note: set off, or in brackets
  it("reads a weight set off by a dash, colon, comma or parentheses", () => {
    expect(splitWeightTail("Tent - 540 g")).toEqual({ name: "Tent", weight: "540 g" });
    expect(splitWeightTail("Tent: 540 g")).toEqual({ name: "Tent", weight: "540 g" });
    expect(splitWeightTail("Tent, 540 g")).toEqual({ name: "Tent", weight: "540 g" });
    expect(splitWeightTail("Tent (540 g)")).toEqual({ name: "Tent", weight: "540 g" });
    expect(splitWeightTail("Tent\t540 g")).toEqual({ name: "Tent", weight: "540 g" });
  });

  // a range is not "Item 3" at 4 oz: the separator needs air on one side
  it("does not split a range", () => {
    expect(splitWeightTail("Fuel 3-4 oz")).toEqual({ name: "Fuel 3-4 oz" });
  });

  it("trims what it hands back", () => {
    expect(splitWeightTail("  Tent  ")).toEqual({ name: "Tent" });
  });

  // a weight with nothing in front of it is a name, as it always was when typed:
  // there is no row for it to be the weight OF; a separator in front of it changes
  // nothing (": 540 g" pasted over a name used to leave the field lying)
  it("keeps a bare weight as the name, separator or not", () => {
    expect(splitWeightTail("540 g")).toEqual({ name: "540 g" });
    expect(splitWeightTail(": 540 g")).toEqual({ name: ": 540 g" });
    expect(splitWeightTail("- 540 g")).toEqual({ name: "- 540 g" });
    expect(splitWeightTail("(540 g)")).toEqual({ name: "(540 g)" });
  });

  // the parentheses come as a pair: a parenthetical that merely ends in a weight is
  // not a weight, and a weight torn out of it would leave "(" behind in the name
  it("does not tear a weight out of a longer parenthetical", () => {
    expect(splitWeightTail("Tent (packed 540 g)")).toEqual({ name: "Tent (packed 540 g)" });
    expect(splitWeightTail("Quilt (20F, 600 g)")).toEqual({ name: "Quilt (20F, 600 g)" });
    expect(splitWeightTail("Socks (2 pairs, 60 g)")).toEqual({ name: "Socks (2 pairs, 60 g)" });
    expect(splitWeightTail("Stove: 85 g)")).toEqual({ name: "Stove: 85 g)" });
  });

  // the field parser sums a compound ("2 lb 3 oz" is 992 g), so the tail hands all of
  // it on; before, only the last group came off and the rest stayed in the name
  it("takes a compound weight whole", () => {
    expect(splitWeightTail("Tent 2 lb 3 oz")).toEqual({ name: "Tent", weight: "2 lb 3 oz" });
    expect(splitWeightTail("Bear Vault BV500 (2 lbs 9 oz)")).toEqual({ name: "Bear Vault BV500", weight: "2 lbs 9 oz" });
    expect(splitWeightTail("Tent - 1 lb 4 oz")).toEqual({ name: "Tent", weight: "1 lb 4 oz" });
  });

  // a dash after a figure is a range, spaced or not
  it("does not split a spaced range", () => {
    expect(splitWeightTail("Fuel 3 - 4 oz")).toEqual({ name: "Fuel 3 - 4 oz" });
    expect(splitWeightTail("Bag 100 - 200 g")).toEqual({ name: "Bag 100 - 200 g" });
  });

  // the unit words and the number token are the field parser's own (shared/weights),
  // so what parses there parses here
  it("reads every unit word the weight field reads, and a bare decimal", () => {
    expect(splitWeightTail("Bear can 1.2 kilograms")).toEqual({ name: "Bear can", weight: "1.2 kilograms" });
    expect(splitWeightTail("Tent 1 kilogram")).toEqual({ name: "Tent", weight: "1 kilogram" });
    expect(splitWeightTail("Bar .9 oz")).toEqual({ name: "Bar", weight: ".9 oz" });
    expect(splitWeightTail("Bar ,9oz")).toEqual({ name: "Bar", weight: ",9oz" });
  });

  // a line of a thousand tabs (a wide spreadsheet row) used to cost most of a second
  it("costs nothing on a long run of whitespace", () => {
    const line = "a" + "\t".repeat(2000) + "b";
    const t0 = performance.now();
    expect(splitWeightTail(line)).toEqual({ name: "a b" });
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("pasteRows", () => {
  it("makes one row per line that says anything, in order", () => {
    expect(pasteRows("Tent 540 g\nQuilt\n\n  \nStove 85 g\n")).toEqual(["Tent 540 g", "Quilt", "Stove 85 g"]);
  });

  it("reads Windows and old Mac line endings, and the Unicode separators a soft return becomes", () => {
    expect(pasteRows("Tent\r\nQuilt\rStove")).toEqual(["Tent", "Quilt", "Stove"]);
    expect(pasteRows("Tent\u2028Quilt\u2029Stove\vPot")).toEqual(["Tent", "Quilt", "Stove", "Pot"]);
  });

  it("strips the list markers a notes app writes", () => {
    expect(pasteRows("- Tent\n* Quilt\n• Stove\n1. Pot\n2) Spoon\n[ ] Map\n[x] Compass\n☐ Filter")).toEqual([
      "Tent", "Quilt", "Stove", "Pot", "Spoon", "Map", "Compass", "Filter",
    ]);
  });

  // a Markdown checklist is a bullet and then a box; both come off
  it("strips stacked markers", () => {
    expect(pasteRows("- [ ] Tent\n- [x] Quilt\n* [ ] Stove\n1. [x] Pot")).toEqual(["Tent", "Quilt", "Stove", "Pot"]);
  });

  // a marker wants a space after it; a sign or an asterisk that is part of the text
  // is not a marker
  it("keeps a leading minus or asterisk that is part of the name", () => {
    expect(pasteRows("-10F bag\n-20 degree quilt\n*Optional* shoes\nPot")).toEqual([
      "-10F bag", "-20 degree quilt", "*Optional* shoes", "Pot",
    ]);
  });

  it("cuts a line longer than any name the list would keep", () => {
    const [row] = pasteRows("x".repeat(500) + "\nPot");
    expect(row!.length).toBeLessThan(300);
  });

  // "2.5 oz bar" is a bar, not item 2 named "5 oz bar"
  it("keeps a line that starts with a number that is not a list number", () => {
    expect(pasteRows("2.5 oz bar\n1.5 L bottle")).toEqual(["2.5 oz bar", "1.5 L bottle"]);
  });

  it("drops a line that is only its marker", () => {
    expect(pasteRows("- Tent\n-\n• \nQuilt")).toEqual(["Tent", "Quilt"]);
  });

  it("is one row for one line, which the caller treats as no list", () => {
    expect(pasteRows("Tent 540 g")).toEqual(["Tent 540 g"]);
    expect(pasteRows("")).toEqual([]);
  });
});
