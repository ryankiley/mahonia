import { describe, expect, it } from "vitest";
import {
  distanceFieldValue,
  distanceUnitFor,
  formatDistance,
  normalizeDistanceUnit,
  normalizeTrailDistanceM,
  parseDistanceM,
  resolveDistanceUnit,
} from "../shared/trailDistance";

describe("parseDistanceM", () => {
  it("reads a bare number in the fallback unit", () => {
    expect(parseDistanceM("12", "km")).toBe(12_000);
    expect(parseDistanceM("7.5", "mi")).toBe(12_070);
  });

  it("reads an explicit unit whatever the list's own is", () => {
    // the case that matters: an imperial number typed on a metric list
    expect(parseDistanceM("7.5 mi", "km")).toBe(12_070);
    expect(parseDistanceM("12km", "mi")).toBe(12_000);
    expect(parseDistanceM("800 m", "mi")).toBe(800);
  });

  it("accepts the spellings people actually type", () => {
    expect(parseDistanceM("7.5 miles", "km")).toBe(12_070);
    expect(parseDistanceM("12 KM", "mi")).toBe(12_000);
    expect(parseDistanceM("12,5 km", "km")).toBe(12_500); // comma decimal
    expect(parseDistanceM("12 kilometres", "mi")).toBe(12_000);
  });

  it("never guesses miles from a bare m — that would multiply a route by 1609", () => {
    expect(parseDistanceM("5000 m", "mi")).toBe(5000);
  });

  it("declines anything that isn't a positive distance", () => {
    expect(parseDistanceM("", "km")).toBeNull();
    expect(parseDistanceM("abc", "km")).toBeNull();
    expect(parseDistanceM("0", "km")).toBeNull();
    expect(parseDistanceM("-5", "km")).toBeNull();
    expect(parseDistanceM("10 furlongs", "km")).toBeNull();
  });

  it("declines a distance past the bound rather than storing it", () => {
    expect(parseDistanceM("99999 km", "km")).toBeNull();
    expect(parseDistanceM("10000 km", "km")).toBe(10_000_000); // exactly at the bound
  });
});

describe("parseDistanceM — pasted off the trail page", () => {
  it("reads a labelled value", () => {
    expect(parseDistanceM("Length: 7.5 mi", "km")).toBe(12_070);
    expect(parseDistanceM("Distance 12 km", "mi")).toBe(12_000);
  });

  it("takes the LENGTH, not the elevation gain, in either order", () => {
    // the shape AllTrails actually shows: a length in km/mi beside a gain in m/ft
    expect(parseDistanceM("7.5 mi • 3,159 ft • Out & back", "km")).toBe(12_070);
    expect(parseDistanceM("3,159 ft • 7.5 mi", "km")).toBe(12_070);
    expect(parseDistanceM("Length: 12 km  Elevation gain: 963 m", "mi")).toBe(12_000);
  });

  it("resolves the comma by shape — thousands vs a decimal comma", () => {
    // the trap: a blanket comma→dot read "3,159 ft" as 3.159 ft
    expect(parseDistanceM("3,159 ft", "km")).toBe(963); // 3159 ft
    expect(parseDistanceM("12,5 km", "mi")).toBe(12_500); // European decimal
    expect(parseDistanceM("1,234.5 km", "mi")).toBe(1_234_500);
    expect(parseDistanceM("1,200 m", "mi")).toBe(1200);
  });

  it("still declines a number qualified by something that isn't a unit", () => {
    // must not fall back to reading the bare number in the list's own unit
    expect(parseDistanceM("10 furlongs", "km")).toBeNull();
    expect(parseDistanceM("Out & back", "km")).toBeNull();
    expect(parseDistanceM("Hard", "km")).toBeNull();
  });

  it("still rejects a negative anywhere it appears", () => {
    expect(parseDistanceM("-5", "km")).toBeNull();
    expect(parseDistanceM("-5 km", "km")).toBeNull();
  });

  it("keeps a bare number meaning the list's own unit", () => {
    expect(parseDistanceM("12", "km")).toBe(12_000);
    expect(parseDistanceM("12", "mi")).toBe(19_312);
  });

  it("groups thousands across a SPACE as well as a comma", () => {
    // taken as the end of the number, "12 000 m" parsed as a bare 12 — twelve MILES
    // on an imperial list — and "1 234 km" threw the leading 1 away
    expect(parseDistanceM("12 000 m", "mi")).toBe(12_000);
    expect(parseDistanceM("12 000 m", "km")).toBe(12_000);
    expect(parseDistanceM("1 234 km", "mi")).toBe(1_234_000);
  });

  it("joins only exact groups of three, so two numbers stay two", () => {
    expect(parseDistanceM("5 10", "km")).toBe(5000);
  });

  it("takes the value however it's spaced or cased", () => {
    expect(parseDistanceM("7.5mi", "km")).toBe(12_070);
    expect(parseDistanceM("7.5 MI", "km")).toBe(12_070);
    expect(parseDistanceM("  12  ", "km")).toBe(12_000);
    expect(parseDistanceM("7.5 mi round trip", "km")).toBe(12_070);
  });
});

describe("distanceUnitFor", () => {
  it("is miles, whatever the list weighs gear in", () => {
    // grams is the useful unit for GEAR; it says nothing about how someone measures a
    // trail, and most of this app's trail signs and pasted pages say miles
    for (const u of ["g", "kg", "oz", "lb"]) expect(distanceUnitFor(u)).toBe("mi");
  });
});

describe("normalizeDistanceUnit", () => {
  it("keeps only the two pickable units", () => {
    expect(normalizeDistanceUnit("km")).toBe("km");
    expect(normalizeDistanceUnit("mi")).toBe("mi");
  });

  it("drops everything else, including units the PARSER accepts", () => {
    // "800 m" is typeable; a list that READS in metres is not a mode we offer
    expect(normalizeDistanceUnit("m")).toBeUndefined();
    expect(normalizeDistanceUnit("ft")).toBeUndefined();
    expect(normalizeDistanceUnit("")).toBeUndefined();
    expect(normalizeDistanceUnit("KM")).toBeUndefined();
    expect(normalizeDistanceUnit(undefined)).toBeUndefined();
    expect(normalizeDistanceUnit(7)).toBeUndefined();
  });
});

describe("resolveDistanceUnit", () => {
  it("prefers the owner's explicit pick", () => {
    expect(resolveDistanceUnit("mi", "g")).toBe("mi");
    expect(resolveDistanceUnit("km", "lb")).toBe("km");
  });

  it("falls back to miles when nothing was picked", () => {
    expect(resolveDistanceUnit(undefined, "g")).toBe("mi");
    expect(resolveDistanceUnit(undefined, "oz")).toBe("mi");
  });

  it("falls back rather than trusting a junk value", () => {
    expect(resolveDistanceUnit("furlongs", "oz")).toBe("mi");
    expect(resolveDistanceUnit("", "g")).toBe("mi");
  });

  it("a pick outlives a later change of weight unit", () => {
    expect(resolveDistanceUnit("km", "oz")).toBe("km"); // picked km, and it stays km
    expect(resolveDistanceUnit("km", "g")).toBe("km");
    expect(resolveDistanceUnit(undefined, "g")).toBe("mi"); // never picked → the default
  });
});

describe("formatDistance", () => {
  it("renders the unit the list reads in", () => {
    expect(formatDistance(12_070, "mi")).toBe("7.5 mi");
    expect(formatDistance(12_070, "km")).toBe("12.1 km");
  });

  it("drops to metres under a kilometre, the way a trailhead sign would", () => {
    expect(formatDistance(800, "km")).toBe("800 m");
    expect(formatDistance(1000, "km")).toBe("1 km");
  });

  it("trims a trailing zero rather than showing 12.0", () => {
    expect(formatDistance(12_000, "km")).toBe("12 km");
  });
});

describe("distanceFieldValue", () => {
  it("round-trips through the parser", () => {
    const stored = parseDistanceM("7.5 mi", "km")!;
    expect(distanceFieldValue(stored, "mi")).toBe("7.5");
    expect(parseDistanceM(distanceFieldValue(stored, "mi"), "mi")).toBe(stored);
  });

  it("is empty when there's nothing stored", () => {
    expect(distanceFieldValue(undefined, "km")).toBe("");
    expect(distanceFieldValue(0, "km")).toBe("");
  });
});

describe("normalizeTrailDistanceM", () => {
  it("keeps a usable distance as a positive integer of metres", () => {
    expect(normalizeTrailDistanceM(12_070)).toBe(12_070);
    expect(normalizeTrailDistanceM(12_070.6)).toBe(12_071);
    expect(normalizeTrailDistanceM("12070")).toBe(12_070);
  });

  it("drops everything a hand-edited backup or hostile client might send", () => {
    expect(normalizeTrailDistanceM(undefined)).toBeUndefined();
    expect(normalizeTrailDistanceM(null)).toBeUndefined();
    expect(normalizeTrailDistanceM(0)).toBeUndefined();
    expect(normalizeTrailDistanceM(-1)).toBeUndefined();
    expect(normalizeTrailDistanceM("abc")).toBeUndefined();
    expect(normalizeTrailDistanceM(Number.NaN)).toBeUndefined();
    expect(normalizeTrailDistanceM(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeTrailDistanceM(1e12)).toBeUndefined();
  });
});
