// The typed-attribute layer of the catalog: what a variant string states is read
// mechanically (extractAttributes), every value has one canonical form
// (validateAttributes), and the CSV cell round-trips. tests/catalog-data.test.ts
// proves the real catalog agrees with itself; this file pins the reader so a rule
// can't quietly stop firing.

import { describe, expect, it } from "vitest";
import {
  extractAttributes,
  parseAttributes,
  serializeAttributes,
  validateAttributes,
  type RowAttributes,
} from "../scripts/catalogAttributes";

describe("extractAttributes reads what a variant states outright", () => {
  const cases: Array<[string, string, string, RowAttributes]> = [
    // [variant, gear type, category, expected]
    ["20F, 950FP, Regular", "Quilt", "sleep", { temp_f: 20, fill_power: 950, length: "Regular" }],
    ["10F, Regular, Regular", "Quilt", "sleep", { temp_f: 10, length: "Regular", width: "Regular" }],
    ["10F, Short, Wide", "Quilt", "sleep", { temp_f: 10, length: "Short", width: "Wide" }],
    ["Long Wide", "Sleeping pad", "sleep", { length: "Long", width: "Wide" }],
    ["Regular Wide Mummy", "Sleeping pad", "sleep", { length: "Regular", width: "Wide" }],
    ["25x72, Tapered", "Sleeping pad", "sleep", { width: "25in", length: "72in" }],
    ["30F, Slim-Short", "Sleeping bag", "sleep", { temp_f: 30, width: "Slim", length: "Short" }],
    ["6ft 6in Wide", "Bivy", "shelter", { length: "6ft 6in", width: "Wide" }],
    ["6ft 0in, 20F", "Sleeping bag", "sleep", { length: "6ft", temp_f: 20 }],
    ["20F / -6C", "Quilt", "sleep", { temp_f: 20 }],
    ["-6C", "Quilt", "sleep", { temp_f: 21 }],
    ["10F, 900FP, XL", "Quilt", "sleep", { temp_f: 10, fill_power: 900, length: "XL" }],
    ["Women's, 30F, Regular", "Sleeping bag", "sleep", { fit: "Women's", temp_f: 30, length: "Regular" }],
    ["950+FP, Regular", "Quilt", "sleep", { fill_power: 950, length: "Regular" }],
    // a letter on sleep gear is the maker's length scale with or without a gender in front
    ["2XL", "Sleeping bag", "sleep", { length: "2XL" }],
    ["Women's 2XL", "Sleeping bag", "sleep", { fit: "Women's", length: "2XL" }],
    // sleep words the axis model can't place are left for research
    ["0F, Standard", "Quilt", "sleep", { temp_f: 0 }],
    ["LW Mummy", "Sleeping pad", "sleep", {}],
    ["Double Wide", "Sleeping pad", "sleep", {}],
    // packs: a letter, a range or a length word is the torso, whatever token carries it
    ["Ultra 200X, M", "Backpack", "pack", { torso: "M" }],
    ["S/M", "Backpack", "pack", { torso: "S/M" }],
    ["Regular torso, M hipbelt", "Backpack", "pack", { torso: "Regular" }],
    ["17in torso", "Backpack", "pack", { torso: "17in" }],
    ["Short", "Backpack", "pack", { torso: "Short" }],
    ["WM/L, 65L", "Backpack", "pack", { fit: "Women's", torso: "M/L", volume_l: 65 }],
    ["Women's XS/S", "Backpack", "pack", { fit: "Women's", torso: "XS/S" }],
    ["S/M", "Running vest", "pack", { size: "S/M" }], // a vest's letter is a chest size, not a torso
    // apparel and footwear
    ["Men's M", "Down jacket", "clothing", { fit: "Men's", size: "M" }],
    ["Men's M, Regular", "Hiking pants", "clothing", { fit: "Men's", size: "M", length: "Regular" }],
    ["Women's", "Trail runners", "clothing", { fit: "Women's" }],
    ["Men's US 9", "Trail runners", "clothing", { fit: "Men's", size: "US 9" }],
    ["Women's UK 10", "Rain jacket", "clothing", { fit: "Women's", size: "UK 10" }],
    ["EU 42", "Hiking boots", "clothing", { size: "EU 42" }],
    ["Men's US 9 / Women's US 10", "Hiking shoes", "clothing", {}],
    ["M, JP 3", "Rain jacket", "clothing", { size: "M" }],
    ["JP 3", "Backpack", "pack", { size: "JP 3" }],
    ["4", "Fleece", "clothing", { size: "4" }],
    ["3-4", "Leggings", "clothing", { size: "3-4" }],
    ["Men's 32", "Pants", "clothing", { fit: "Men's", size: "32" }],
    ["Size D", "Insoles", "clothing", { size: "D" }],
    ["3L", "Rain jacket", "clothing", {}], // a fabric, not litres
    ["120gsm", "Fleece", "clothing", {}],
    // volumes
    ["3L", "Water reservoir", "water", { volume_l: 3 }],
    ["500ml", "Soft flask", "water", { volume_l: 0.5 }],
    ["525ml", "Water bottle", "water", { volume_l: 0.525 }],
    ["32oz / 1L", "Water bottle", "water", { volume_l: 1 }],
    ["16oz", "Jar", "cook", { volume_l: 0.473 }],
    ["24 fl oz", "Water filter", "water", { volume_l: 0.71 }],
    ["1.75oz", "Snack mix", "consumable", {}], // a net weight, not a volume
    ["1L Tritan", "Water bottle", "water", { volume_l: 1 }],
    ["52qt", "Cooler", "other", { volume_l: 49.21 }],
    // shelters, batteries, canisters, lengths
    ["2P", "Tent", "shelter", { persons: 2 }],
    ["1.5P", "Tent", "shelter", { persons: 1.5 }],
    ["UL2", "Tent", "shelter", { persons: 2 }],
    ["4 Person", "Tent", "shelter", { persons: 4 }],
    ["10000mAh", "Power bank", "electronics", { capacity_mah: 10000 }],
    ["110g, net fuel", "Fuel canister", "consumable", { fuel_g: 110 }],
    ["per tablet, 14g", "Fuel tablets", "consumable", {}],
    ["100-120cm, per pair", "Trekking poles", "other", { length: "100-120cm" }],
    ["Aluminum, per pair", "Trekking poles", "other", {}],
    ["2mm, 50ft", "Guyline", "other", { length: "50ft" }],
    ["50ft hank", "Guyline", "other", { length: "50ft" }],
    ["1m", "Charging cable", "electronics", { length: "1m" }],
    ["6in", "Tent stakes", "other", { length: "6in" }],
    ["14in", "Camp stool", "other", {}], // a height
    ["25F, 25in", "Sheet", "sleep", { temp_f: 25, width: "25in" }],
    ["42mm, Aluminum, GPS", "Smartwatch", "electronics", {}],
    ["8ft x 10ft", "Tarp", "shelter", {}],
    // a value the validator would refuse is not read: the token stays for research
    ["330mAh", "Power bank", "electronics", {}],
    ["10, 000mAh", "Power bank", "electronics", {}],
    ["-70F", "Quilt", "sleep", {}],
    ["6ft 06in", "Sleeping bag", "sleep", {}],
    ["M+", "Quilt", "sleep", {}],
    // size words on gear sold in named sizes
    // the variant's word is the axis's letter (the S/M/L family; a pillow is not length-scaled)
    ["Large", "Pillow", "sleep", { size: "L" }],
    ["Medium", "Backpack", "pack", { torso: "M" }],
    ["Men's Medium", "Sun hoodie", "clothing", { fit: "Men's", size: "M" }],
    ["Medium torso", "Backpack", "pack", { torso: "M" }],
    ["Jumbo", "Stuff sack", "other", { size: "Jumbo" }],
    ["M+", "Pillow", "sleep", { size: "M+" }],
    ["Standard", "Food bag", "other", {}],
    ["2 servings, net", "Meal", "consumable", {}],
    ["", "Tent", "shelter", {}],
  ];
  for (const [variant, type, cat, expected] of cases) {
    it(`"${variant}" on a ${type} → ${JSON.stringify(expected)}`, () => {
      expect(extractAttributes(variant, type, cat)).toEqual(expected);
    });
  }

  it("reports a variant that claims one axis twice in the same spelling, and not one that restates a fact", () => {
    const conflicts = (variant: string, type: string, cat: string) => {
      const out: string[] = [];
      extractAttributes(variant, type, cat, (c) => out.push(c));
      return out;
    };
    expect(conflicts("Regular, Long", "Quilt", "sleep")).toEqual(['length: "Regular" and "Long"']);
    expect(conflicts("20F, 30F", "Quilt", "sleep")).toEqual(['temp_f: "20" and "30"']);
    expect(conflicts("Regular, 6ft, 20F", "Sleeping bag", "sleep")).toEqual([]); // a word and a measurement
    expect(conflicts("Men's US 9, EU 42", "Hiking boots", "clothing")).toEqual([]); // two regions
    expect(conflicts("M, JP 3", "Rain jacket", "clothing")).toEqual([]); // a letter and a region
    expect(conflicts("10F, Regular, Regular", "Quilt", "sleep")).toEqual([]); // length, then width
  });
});

describe("validateAttributes holds every value to one canonical form", () => {
  it("accepts the forms the extractor emits", () => {
    expect(validateAttributes({ fit: "Men's", size: "US 9", torso: "S/M", length: "6ft 6in", width: "Wide", temp_f: -10, fill_power: 850, r_value: 4.5, persons: 1.5, volume_l: 0.525, capacity_mah: 10000, fuel_g: 110, fuel: "isobutane" })).toEqual([]);
    expect(validateAttributes({ temp_f: 0 })).toEqual([]);
    expect(validateAttributes(null)).toEqual([]);
    expect(validateAttributes(undefined)).toEqual([]);
  });
  it("rejects an unknown key, a wrong type, a value off its grid or range, a non-canonical spelling", () => {
    expect(validateAttributes({ temp: 20 })).toEqual([expect.stringMatching(/unknown attribute "temp"/)]);
    expect(validateAttributes({ temp_f: "20F" })).toEqual([expect.stringMatching(/temp_f: must be a number/)]);
    expect(validateAttributes({ temp_f: 20.5 })).toEqual([expect.stringMatching(/temp_f/)]);
    expect(validateAttributes({ fill_power: 85 })).toEqual([expect.stringMatching(/fill_power/)]);
    expect(validateAttributes({ persons: 2.25 })).toEqual([expect.stringMatching(/persons/)]);
    expect(validateAttributes({ r_value: 4.55 })).toEqual([expect.stringMatching(/r_value/)]);
    expect(validateAttributes({ volume_l: 0.0005 })).toEqual([expect.stringMatching(/volume_l/)]);
    expect(validateAttributes({ volume_l: 1e-7 })).toEqual([expect.stringMatching(/volume_l/)]);
    expect(validateAttributes({ size: "Medium " })).toEqual([expect.stringMatching(/size/)]);
    expect(validateAttributes({ size: "medium" })).toEqual([expect.stringMatching(/not a canonical size/)]);
    expect(validateAttributes({ length: "6 ft" })).toEqual([expect.stringMatching(/not a canonical length/)]);
    expect(validateAttributes({ fit: "Mens" })).toEqual([expect.stringMatching(/not a canonical fit/)]);
    expect(validateAttributes({ fuel: "gas" })).toEqual([expect.stringMatching(/not a canonical fuel/)]);
    expect(validateAttributes({ width: null })).toEqual([expect.stringMatching(/omit the key/)]);
    expect(validateAttributes(["temp_f"])).toEqual(["attributes must be an object"]);
  });
});

describe("the CSV cell", () => {
  it("serialises in key order and parses back to the same object", () => {
    const a: RowAttributes = { length: "Regular", temp_f: 20, fill_power: 950, fit: "Women's" };
    const cell = serializeAttributes(a);
    expect(cell).toBe("fit=Women's; length=Regular; temp_f=20; fill_power=950");
    expect(parseAttributes(cell)).toEqual(a);
    expect(serializeAttributes(null)).toBe("");
    expect(serializeAttributes({})).toBe("");
    expect(parseAttributes("")).toBeNull();
    expect(parseAttributes("volume_l=0.525")).toEqual({ volume_l: 0.525 });
    expect(parseAttributes("temp_f=0")).toEqual({ temp_f: 0 });
    expect(parseAttributes("temp_f=-10")).toEqual({ temp_f: -10 });
  });
  it("refuses a malformed or non-canonical cell, including a number only Number() would read", () => {
    expect(() => parseAttributes("temp_f")).toThrow(/key=value/);
    expect(() => parseAttributes("temp_f=20; temp_f=30")).toThrow(/twice/);
    expect(() => parseAttributes("temp_f=warm")).toThrow(/temp_f/);
    expect(() => parseAttributes("temp_f=")).toThrow(/not a plain number/);
    expect(() => parseAttributes("temp_f=0x14")).toThrow(/not a plain number/);
    expect(() => parseAttributes("temp_f=2e1")).toThrow(/not a plain number/);
    expect(() => parseAttributes("temp_f= 20")).toThrow(/not a plain number/);
    expect(() => parseAttributes("volume_l=.5")).toThrow(/not a plain number/);
    expect(() => parseAttributes("colour=blue")).toThrow(/unknown attribute/);
    expect(() => parseAttributes("constructor=1")).toThrow(/unknown attribute/);
  });
});
