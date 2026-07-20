import { describe, expect, it } from "vitest";
import { GEAR_TYPE_ALIASES, normalizeGearType } from "../shared/gearTypes";

describe("normalizeGearType", () => {
  it("collapses drift labels to their canonical common name", () => {
    expect(normalizeGearType("tent stake")).toBe("tent stakes");
    expect(normalizeGearType("running shoes")).toBe("trail runners");
    expect(normalizeGearType("windbreaker")).toBe("wind jacket");
    expect(normalizeGearType("hipbelt pocket")).toBe("hip belt pocket");
  });

  it("lowercases + trims, and passes an already-canonical label through", () => {
    expect(normalizeGearType("  Tent  ")).toBe("tent");
    expect(normalizeGearType("trekking poles")).toBe("trekking poles");
    expect(normalizeGearType("")).toBe("");
    expect(normalizeGearType(null)).toBe("");
  });

  it("has no alias chains — a canonical target is never itself a drift key", () => {
    for (const to of Object.values(GEAR_TYPE_ALIASES)) {
      expect(GEAR_TYPE_ALIASES[to]).toBeUndefined();
    }
  });
});
