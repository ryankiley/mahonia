import { describe, expect, it } from "vitest";
import { GEAR_TYPE_ALIASES, normalizeGearType } from "../scripts/gearTypes";

describe("normalizeGearType", () => {
  it("collapses drift labels to their canonical common name (sentence-cased)", () => {
    expect(normalizeGearType("tent stake")).toBe("Tent stakes");
    expect(normalizeGearType("running shoes")).toBe("Trail runners");
    expect(normalizeGearType("windbreaker")).toBe("Wind jacket");
    expect(normalizeGearType("hipbelt pocket")).toBe("Hip belt pocket");
  });

  it("sentence-cases the first word (acronyms upper-cased), trims, passes canonical through", () => {
    expect(normalizeGearType("  tent  ")).toBe("Tent");
    expect(normalizeGearType("trekking poles")).toBe("Trekking poles");
    expect(normalizeGearType("gps watch")).toBe("GPS watch");
    expect(normalizeGearType("plb")).toBe("PLB");
    expect(normalizeGearType("")).toBe("");
    expect(normalizeGearType(null)).toBe("");
  });

  it("has no alias chains — a canonical target is never itself a drift key", () => {
    for (const to of Object.values(GEAR_TYPE_ALIASES)) {
      expect(GEAR_TYPE_ALIASES[to]).toBeUndefined();
    }
  });
});
