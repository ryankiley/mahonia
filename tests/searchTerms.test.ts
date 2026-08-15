import { describe, expect, it } from "vitest";
import { buildSearchTerms, deriveNoun } from "../scripts/searchTerms";

describe("deriveNoun", () => {
  it("reads a gear noun straight out of the name", () => {
    expect(deriveNoun("Nemo Tensor Sleeping Pad")).toBe("sleeping pad");
    expect(deriveNoun("MSR PocketRocket Stove")).toBe("stove");
  });

  it("prefers the longest matching noun", () => {
    expect(deriveNoun("Sea to Summit Sleeping Bag Liner")).toBe("sleeping bag liner");
  });

  it("resolves a locale/synonym alias to its canonical noun", () => {
    expect(deriveNoun("Osprey Rucksack 40")).toBe("backpack");
    expect(deriveNoun("Petzl Head Torch")).toBe("headlamp");
  });

  it("only matches on word boundaries (no false 'tent' in 'Tentacle')", () => {
    expect(deriveNoun("Tentacle Gear Widget")).toBeNull();
    expect(deriveNoun("Backpacking Kit")).toBeNull(); // 'backpack' needs a boundary
  });

  it("returns null when the name carries no gear word", () => {
    expect(deriveNoun("Big Agnes Copper Spur HV UL2")).toBeNull();
    expect(deriveNoun("Durston X-Mid 2")).toBeNull();
  });
});

describe("buildSearchTerms", () => {
  it("falls back to a category default for a model-only name", () => {
    // The marquee case: model-named tents become findable by "tent".
    expect(buildSearchTerms("Copper Spur HV UL2", "shelter")).toBe("tent");
    expect(buildSearchTerms("Osprey Exos 58", "pack")).toBe("backpack rucksack");
  });

  it("prefers the name-derived noun over the category default", () => {
    // A tarp in the shelter category must stay 'tarp', not become 'tent'.
    expect(buildSearchTerms("Hyperlite Flat Tarp", "shelter")).toBe("tarp");
    expect(buildSearchTerms("Zpacks Bivy", "shelter")).toBe("bivy");
  });

  it("folds every alias for the noun into the terms", () => {
    const terms = buildSearchTerms("Nemo Tensor Sleeping Pad", "sleep");
    expect(terms).toContain("sleeping pad");
    expect(terms).toContain("mattress"); // UK/colloquial term matches the same row
  });

  it("returns null for an ambiguous category with no name noun", () => {
    // 'sleep' has no default (bag vs pad vs quilt) — don't guess.
    expect(buildSearchTerms("Katabatic Flex", "sleep")).toBeNull();
    expect(buildSearchTerms("Some Widget", "other")).toBeNull();
    expect(buildSearchTerms("Some Widget", null)).toBeNull();
  });

  it("falls back to the row's gear type when nothing else resolves", () => {
    // The ambiguous categories the default skips: the row's own "what it is" label
    // answers what the name couldn't, so a model-named quilt is findable by "quilt".
    expect(buildSearchTerms("Katabatic Flex", "sleep", "Quilt")).toBe("quilt");
    expect(buildSearchTerms("Katabatic Flex", "sleep", "Sleeping pad")).toContain("mattress");
    expect(buildSearchTerms("Some Widget", null, "Water filter")).toBe("water filter");
  });

  it("keeps the gear type BEHIND the category default (purely additive)", () => {
    // A model-named shelter row already resolves to 'tent'; consulting its gear type
    // first would change terms that rows already have, which this fallback must not do.
    // (So a model-named tarp keeps 'tent' — the cost of staying additive-only.)
    expect(buildSearchTerms("Durston X-Mid 2", "shelter", "Tarp")).toBe("tent");
    // …and behind the name, which stays the strongest signal.
    expect(buildSearchTerms("Hyperlite Flat Tarp", "shelter", "Tent")).toBe("tarp");
  });

  it("still returns null when the gear type carries no known noun", () => {
    expect(buildSearchTerms("Some Widget", null, "Doohickey")).toBeNull();
    expect(buildSearchTerms("Some Widget", null, "")).toBeNull();
    expect(buildSearchTerms("Some Widget", null, null)).toBeNull();
  });
});
