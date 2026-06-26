import { describe, expect, it } from "vitest";
import { formatVolume, parseVolumeMl, waterMgFromMl } from "../shared/water";

describe("parseVolumeMl — human volume → millilitres", () => {
  it("reads litres (the default for a bare number) and millilitres", () => {
    expect(parseVolumeMl("1L")).toBe(1000);
    expect(parseVolumeMl("1 l")).toBe(1000);
    expect(parseVolumeMl("1.5L")).toBe(1500);
    expect(parseVolumeMl("2")).toBe(2000); // bare number = litres
    expect(parseVolumeMl("0.5")).toBe(500);
    expect(parseVolumeMl("1,5 l")).toBe(1500); // comma decimal
    expect(parseVolumeMl("500ml")).toBe(500);
    expect(parseVolumeMl("750 ml")).toBe(750);
    expect(parseVolumeMl("1 liter")).toBe(1000);
    expect(parseVolumeMl("2 litres")).toBe(2000);
    expect(parseVolumeMl("1cl")).toBe(10);
    expect(parseVolumeMl("1dl")).toBe(100);
  });

  it("reads US fluid ounces ('oz' means fl oz for water)", () => {
    expect(parseVolumeMl("32 fl oz")).toBeCloseTo(946.352, 2);
    expect(parseVolumeMl("32floz")).toBeCloseTo(946.352, 2);
    expect(parseVolumeMl("32oz")).toBeCloseTo(946.352, 2);
  });

  it("rejects junk, non-positive, and non-volume units", () => {
    for (const v of ["", "abc", "0", "-1", "1 banana", "L", "1 kg", "1 lb"]) {
      expect(parseVolumeMl(v), v).toBeNull();
    }
    // @ts-expect-error guard against null input
    expect(parseVolumeMl(null)).toBeNull();
  });
});

describe("waterMgFromMl — water is ~1 g/mL", () => {
  it("converts millilitres to integer milligrams", () => {
    expect(waterMgFromMl(1000)).toBe(1_000_000); // 1 L = 1 kg
    expect(waterMgFromMl(500)).toBe(500_000);
    expect(waterMgFromMl(946.352)).toBe(946_352);
  });
});

describe("formatVolume — tidy labels", () => {
  it("uses L at/above a litre, mL below, trimming trailing zeros", () => {
    expect(formatVolume(1000)).toBe("1 L");
    expect(formatVolume(1500)).toBe("1.5 L");
    expect(formatVolume(1250)).toBe("1.25 L");
    expect(formatVolume(2000)).toBe("2 L");
    expect(formatVolume(500)).toBe("500 mL");
    expect(formatVolume(946.352)).toBe("946 mL");
  });
});
