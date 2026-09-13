// The text rule that says a row is stove fuel, and the two things it decides beyond the
// row's picture: no calorie field while it holds no number, no worn toggle unless it is
// already worn. One rule read by the editor row and My Gear's dialog, so it is pinned once,
// here, rather than once per surface. (The picture lives with the glyphs — itemMarks.)
import { describe, expect, it } from "vitest";
import { isFuelRow, offersKcal, offersWorn } from "~~/shared/fuel";

describe("isFuelRow", () => {
  it("takes the word, the chemistry and the brands that mean stove fuel", () => {
    for (const name of [
      "Fuel", "fuel canister", "Solid fuel tablets", "Gas", "Gas canister", "Camping gas",
      "Isobutane 110g", "Butane/propane mix", "Propane 1 lb", "IsoPro 227", "JetPower 100g",
      "Esbit", "Campingaz CV300", "HEET", "Meths", "Methylated spirits", "Methylated-spirit", "Denatured alcohol", "Alcohol fuel",
    ]) expect(isFuelRow({ name }), name).toBe(true);
  });

  it("reads the gear type too, so a catalog pick counts whatever the maker called it", () => {
    expect(isFuelRow({ name: "C300 Xtreme Gas Cartridge", commonName: "Fuel canister" })).toBe(true);
    expect(isFuelRow({ name: "Power Gas 250 Triple Mix", commonName: "Fuel canister" })).toBe(true);
    // the gear type alone is enough — the product name need not say fuel at all
    expect(isFuelRow({ name: "Universal", commonName: "Fuel canister" })).toBe(true);
    expect(isFuelRow({ name: "Solid Tablets", commonName: "Fuel tablets" })).toBe(true);
  });

  it("leaves a bear canister, the wipes and the rest of the food alone", () => {
    for (const name of [
      "Bear canister", "BV500", "Alcohol wipes", "Rubbing alcohol", "Peanut butter", "Trail mix",
      "Gasket", "Sheet", "Water", "Stove", "Pot", "Sunscreen", "Isopropyl alcohol", "Peak Refuel Pasta", "FuelFlask 150ml", "",
    ]) expect(isFuelRow({ name }), name || "(blank)").toBe(false);
  });

  it("a name that says the thing is eaten or worn outranks the fuel word in it", () => {
    // sports nutrition is full of "fuel" — and a drink mix that lost its calorie field
    // would be the one row the rule exists to protect, refused
    for (const name of [
      "Tailwind Endurance Fuel", "SiS Beta Fuel gel", "Precision Fuel PF30 gel", "Fuel For Fire pouch",
      "Trail fuel bars", "Jet fuel coffee", "Gas station snacks", "Fuel belt",
    ]) expect(isFuelRow({ name }), name).toBe(false);
    // ...read off the gear type as readily as the name
    expect(isFuelRow({ name: "Endurance Fuel", commonName: "Drink powder" })).toBe(false);
    expect(isFuelRow({ name: "Endurance Fuel", commonName: "Energy gel" })).toBe(false);
    // and none of it rescues the real thing — "mix" is in a canister's name too
    expect(isFuelRow({ name: "Power Gas 105 Triple Mix" })).toBe(true);
  });
});

describe("offersKcal", () => {
  it("offers the field on food, and withholds it on fuel that holds no number", () => {
    expect(offersKcal({ name: "Dinner", commonName: "Meal" })).toBe(true);
    expect(offersKcal({ name: "Trail mix" })).toBe(true);
    expect(offersKcal({ name: "Tailwind Endurance Fuel" })).toBe(true);
    expect(offersKcal({ name: "IsoPro 110", commonName: "Fuel canister" })).toBe(false);
    expect(offersKcal({ name: "Propane 1 lb" })).toBe(false);
    // a zero is the reducer's "absent", so it is nothing to clear either
    expect(offersKcal({ name: "Gas canister", kcal: 0 })).toBe(false);
  });

  it("keeps the field on a fuel row that already carries a value — a count that must stay clearable", () => {
    expect(offersKcal({ name: "IsoPro 110", commonName: "Fuel canister", kcal: 1350 })).toBe(true);
    expect(offersKcal({ name: "Esbit", kcal: 1 })).toBe(true);
  });
});

describe("offersWorn", () => {
  it("offers the toggle on everything but water and stove fuel", () => {
    expect(offersWorn({ name: "Rain jacket" }, false)).toBe(true);
    expect(offersWorn({ name: "Fuel belt" }, false)).toBe(true);
    expect(offersWorn({ name: "Water" }, false)).toBe(false);
    expect(offersWorn({ name: "Gas canister" }, false)).toBe(false);
    expect(offersWorn({ name: "IsoPro", commonName: "Fuel canister" }, false)).toBe(false);
  });

  it("keeps it wherever the row already says worn, so the value can be walked back", () => {
    expect(offersWorn({ name: "Gas canister" }, true)).toBe(true);
    expect(offersWorn({ name: "Water" }, true)).toBe(true);
  });
});
