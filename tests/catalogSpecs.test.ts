// A piece's specs line (shared/catalogSpecs): what its catalog row's typed axes say,
// minus what its own size already says, in the reader's units.
import { describe, expect, it } from "vitest";
import { parseAttributeCell, specParts } from "../shared/catalogSpecs";

describe("parseAttributeCell", () => {
  it("reads the cell the build writes, and skips what doesn't parse", () => {
    expect([...parseAttributeCell("length=Regular; temp_f=20; fill_power=950")]).toEqual([
      ["length", "Regular"],
      ["temp_f", "20"],
      ["fill_power", "950"],
    ]);
    expect(parseAttributeCell("junk; =x; r_value=4.5").get("r_value")).toBe("4.5");
    expect(parseAttributeCell(null).size).toBe(0);
  });
});

describe("specParts", () => {
  it("shows the axes that describe the gear, in one order, never the ones that pick a size", () => {
    expect(specParts("fit=Men's; size=M; length=Regular; width=Wide; fill_power=900; temp_f=20", null, "g")).toEqual([
      "-7°C",
      "900 fill",
    ]);
    expect(specParts("r_value=4.5; length=Regular", "Regular", "oz")).toEqual(["R 4.5"]);
    expect(specParts("persons=2", null, "g")).toEqual(["2P"]);
    expect(specParts("capacity_mah=10000", "PowerCore 10K, A1229", "g")).toEqual(["10,000 mAh"]);
    expect(specParts("fuel=isobutane", null, "g")).toEqual(["isobutane"]);
    expect(specParts("size=M; insulation_gsm=60", "Men's Medium", "g")).toEqual(["60 gsm"]);
    expect(specParts("lumens=1200", null, "oz")).toEqual(["1,200 lumens"]);
  });

  it("reads a rating in °F for someone who weighs in ounces and pounds, °C otherwise", () => {
    expect(specParts("temp_f=20", null, "oz")).toEqual(["20°F"]);
    expect(specParts("temp_f=20", null, "lb")).toEqual(["20°F"]);
    expect(specParts("temp_f=-15", null, "kg")).toEqual(["-26°C"]);
  });

  it("writes a small volume in millilitres and a pack's in litres", () => {
    expect(specParts("volume_l=0.22", null, "g")).toEqual(["220 mL"]);
    expect(specParts("volume_l=40", null, "g")).toEqual(["40 L"]);
  });

  it("leaves out what the piece's own size already says, however the maker spelled it", () => {
    expect(specParts("temp_f=20; fill_power=950; length=Regular", "20F, 950FP, Regular", "oz")).toEqual([]);
    expect(specParts("volume_l=40", "40L", "g")).toEqual([]);
    expect(specParts("volume_l=0.5", "500ml", "g")).toEqual([]);
    expect(specParts("fuel_g=110", "110g, net fuel", "g")).toEqual([]);
    expect(specParts("persons=2", "2P", "g")).toEqual([]);
    expect(specParts("insulation_gsm=90", "90gsm, Medium", "g")).toEqual([]);
    expect(specParts("insulation_gsm=167", "APEX 167, Medium Wide", "g")).toEqual([]);
    expect(specParts("lumens=400", "400 lumen, USB-C", "g")).toEqual([]);
    expect(specParts("lumens=425", "HeadLamp 425 ", "g")).toEqual(["425 lumens"]);
    // the name counts as said, too
    expect(specParts("volume_l=40", "Arc Haul Ultra 40L ", "g")).toEqual([]);
    expect(specParts("persons=2", "X-Mid 2 ", "g")).toEqual(["2P"]);
    // a number inside another number is not the same number
    expect(specParts("temp_f=0", "10F", "oz")).toEqual(["0°F"]);
    expect(specParts("volume_l=5", "1.5L", "g")).toEqual(["5 L"]);
  });

  it("says nothing for gear with no axes", () => {
    expect(specParts(undefined, "Medium", "g")).toEqual([]);
    expect(specParts("", null, "g")).toEqual([]);
  });
});
