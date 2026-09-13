// The picture on a consumable mark is one rule read by three surfaces (the editor row,
// the share row, /gear), so it is pinned once, here, rather than once per surface.
import { CookieIcon, DropletIcon, Fuel01Icon } from "@hugeicons/core-free-icons";
import { describe, expect, it } from "vitest";
import { consumableIcon, isFuelRow } from "../app/utils/itemMarks";

describe("isFuelRow", () => {
  it("takes the word, the chemistry and the brands that mean stove fuel", () => {
    for (const name of [
      "Fuel", "fuel canister", "Solid fuel tablets", "Gas", "Gas canister", "Camping gas",
      "Isobutane 110g", "Butane/propane mix", "Propane 1 lb", "IsoPro 227", "JetPower 100g",
      "Esbit", "Campingaz CV300", "HEET", "Meths", "Methylated spirits", "Denatured alcohol", "Alcohol fuel",
    ]) expect(isFuelRow({ name }), name).toBe(true);
  });

  it("reads the gear type too, so a catalog pick counts whatever the maker called it", () => {
    expect(isFuelRow({ name: "C300 Xtreme Gas Cartridge", commonName: "Fuel canister" })).toBe(true);
    expect(isFuelRow({ name: "Power Gas 250", commonName: "Fuel canister" })).toBe(true);
    // the gear type alone is enough — the product name need not say fuel at all
    expect(isFuelRow({ name: "Universal", commonName: "Fuel canister" })).toBe(true);
    expect(isFuelRow({ name: "Solid Tablets", commonName: "Fuel tablets" })).toBe(true);
  });

  it("leaves a bear canister, the wipes and the rest of the food alone", () => {
    for (const name of [
      "Bear canister", "BV500", "Alcohol wipes", "Rubbing alcohol", "Peanut butter", "Trail mix",
      "Gasket", "Sheet", "Water", "Stove", "Pot", "Sunscreen", "Isopropyl alcohol", "",
    ]) expect(isFuelRow({ name }), name || "(blank)").toBe(false);
  });
});

describe("consumableIcon", () => {
  it("draws the droplet on water, the fuel can on fuel and the cookie on everything else", () => {
    expect(consumableIcon({ name: "Water" })).toBe(DropletIcon);
    expect(consumableIcon({ name: "Fuel canister" })).toBe(Fuel01Icon);
    expect(consumableIcon({ name: "MSR IsoPro", commonName: "Fuel canister" })).toBe(Fuel01Icon);
    expect(consumableIcon({ name: "Dinner", commonName: "Meal" })).toBe(CookieIcon);
    expect(consumableIcon({ name: "Sunscreen" })).toBe(CookieIcon);
  });

  it("water wins over fuel, as it must: its mark is fixed and its class can't change", () => {
    // "water" is exact-match, so this can only ever be a name that is both — there
    // isn't one — but the order of the two tests is the contract, so it is pinned
    expect(consumableIcon({ name: "water", commonName: "Fuel canister" })).toBe(DropletIcon);
  });
});
