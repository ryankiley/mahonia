// The picture on a consumable mark is one rule read by three surfaces (the editor row,
// the share row, /gear), so it is pinned once, here, rather than once per surface. The
// text rules it reads — which rows are water, which are fuel — are pinned in fuel.test.ts.
import { IconCookies, IconDrop } from "../app/icons/central";
import { FuelCanGlyph } from "../app/icons/mahonia";
import { describe, expect, it } from "vitest";
import { consumableIcon } from "../app/utils/itemMarks";

describe("consumableIcon", () => {
  it("draws the droplet on water, the fuel can on fuel and the cookie on everything else", () => {
    expect(consumableIcon({ name: "Water" })).toBe(IconDrop);
    expect(consumableIcon({ name: "Fuel canister" })).toBe(FuelCanGlyph);
    expect(consumableIcon({ name: "MSR IsoPro", commonName: "Fuel canister" })).toBe(FuelCanGlyph);
    expect(consumableIcon({ name: "Dinner", commonName: "Meal" })).toBe(IconCookies);
    expect(consumableIcon({ name: "Tailwind Endurance Fuel" })).toBe(IconCookies);
    expect(consumableIcon({ name: "Sunscreen" })).toBe(IconCookies);
  });

  it("water wins over fuel, as it must: its mark is fixed and its class can't change", () => {
    // "water" is exact-match, so the only row that is both is one whose GEAR TYPE says
    // fuel — reachable, if odd — and the order of the two tests is the contract
    expect(consumableIcon({ name: "water", commonName: "Fuel canister" })).toBe(IconDrop);
  });
});
