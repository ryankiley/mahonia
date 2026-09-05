import { describe, expect, it } from "vitest";
import { formatVolume, itemQtyLabel, parseVolumeMl, waterMgFromMl } from "../shared/water";

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

describe("itemQtyLabel — amount labels incl. the worn split", () => {
  const socks = { name: "Socks", qty: 3, unitWeightMg: 100_000, wornQty: 1 };
  it("shows the worn split on a base line", () => {
    expect(itemQtyLabel(socks, "base")).toBe("×3 · 1 worn");
  });
  it("keeps the plain ×qty when the class is worn or the split is absent", () => {
    expect(itemQtyLabel(socks, "worn")).toBe("×3");
    expect(itemQtyLabel({ ...socks, wornQty: undefined }, "base")).toBe("×3");
    expect(itemQtyLabel(socks)).toBe("×3"); // no class passed = legacy behavior
  });
  it("keeps water as a volume label regardless of any split", () => {
    expect(itemQtyLabel({ name: "Water", qty: 1, unitWeightMg: 2_000_000, wornQty: 1 }, "base")).toBe("2 L");
  });
  it("counts a water row's volume across its whole line, not one unit of it", () => {
    // two 1 L bottles weigh 2,000 g, so the amount beside that figure has to say 2 L —
    // reading the UNIT volume made the row's two numbers disagree by a factor of qty
    expect(itemQtyLabel({ name: "Water", qty: 2, unitWeightMg: 1_000_000 }, "consumable")).toBe("2 L");
    expect(itemQtyLabel({ name: "Water", qty: 3, unitWeightMg: 500_000 }, "consumable")).toBe("1.5 L");
  });
  it("hideSingle drops a bare ×1 and nothing else", () => {
    const tent = { name: "Tent", qty: 1, unitWeightMg: 500_000 };
    expect(itemQtyLabel(tent, "base", { hideSingle: true })).toBe("");
    expect(itemQtyLabel(tent, "base")).toBe("×1"); // opt-in only — the editor still counts
    // a real count, a split and a volume all still speak
    expect(itemQtyLabel(socks, "base", { hideSingle: true })).toBe("×3 · 1 worn");
    expect(itemQtyLabel({ ...socks, wornQty: undefined }, "base", { hideSingle: true })).toBe("×3");
    expect(itemQtyLabel({ name: "Water", qty: 1, unitWeightMg: 1_000_000 }, "consumable", { hideSingle: true })).toBe("1 L");
    // …and a single WORN unit of one is still a split worth naming
    expect(itemQtyLabel({ name: "Hat", qty: 1, unitWeightMg: 50_000, wornQty: 1 }, "base", { hideSingle: true })).toBe("×1 · 1 worn");
  });
});
