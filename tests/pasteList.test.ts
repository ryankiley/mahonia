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
  // there is no row for it to be the weight OF
  it("keeps a bare weight as the name", () => {
    expect(splitWeightTail("540 g")).toEqual({ name: "540 g" });
  });
});

describe("pasteRows", () => {
  it("makes one row per line that says anything, in order", () => {
    expect(pasteRows("Tent 540 g\nQuilt\n\n  \nStove 85 g\n")).toEqual(["Tent 540 g", "Quilt", "Stove 85 g"]);
  });

  it("reads Windows and old Mac line endings", () => {
    expect(pasteRows("Tent\r\nQuilt\rStove")).toEqual(["Tent", "Quilt", "Stove"]);
  });

  it("strips the list markers a notes app writes", () => {
    expect(pasteRows("- Tent\n* Quilt\n• Stove\n1. Pot\n2) Spoon\n[ ] Map\n[x] Compass\n☐ Filter")).toEqual([
      "Tent", "Quilt", "Stove", "Pot", "Spoon", "Map", "Compass", "Filter",
    ]);
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
