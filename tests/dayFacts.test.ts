import { describe, expect, it } from "vitest";
import { coolerByC, dayFacts } from "../shared/dayFacts";
import { dayRanges } from "../shared/tripPlan";

// A 24 km route sampled every 100 m (241 samples): flat at 1,000 m for 6 km, a steady
// climb of 600 m over 6 km, a 2 km summit plateau at 1,600 m, a descent to 1,200 m over
// 4 km, then flat to the end. Two days of 12 km each: day 1 ends at 12 km, the top of
// the climb and the start of the plateau; day 2 ends at 1,200 m.
const ROUTE_M = 24_000;
const profile = Array.from({ length: 241 }, (_, i) => {
  const km = i / 10;
  if (km <= 6) return 1000;
  if (km <= 12) return 1000 + (km - 6) * 100;
  if (km <= 14) return 1600;
  if (km <= 18) return 1600 - (km - 14) * 100;
  return 1200;
});
const ranges = dayRanges([12_000, 12_000]);

describe("dayFacts", () => {
  it("reads the camp, the high and low points and the height over the trailhead off the profile", () => {
    const d1 = dayFacts(profile, ROUTE_M, ranges[0]!)!;
    expect(d1.campM).toBe(1600);
    expect(d1.highM).toBe(1600);
    expect(d1.lowM).toBe(1000);
    expect(d1.aboveTrailheadM).toBe(600);
    const d2 = dayFacts(profile, ROUTE_M, ranges[1]!)!;
    expect(d2.campM).toBe(1200);
    expect(d2.highM).toBe(1600);
    expect(d2.lowM).toBe(1200);
    expect(d2.aboveTrailheadM).toBe(200);
  });

  it("names the longest climb: where it starts, how long it runs, what it gains", () => {
    const d1 = dayFacts(profile, ROUTE_M, ranges[0]!)!;
    expect(d1.climb).toBeDefined();
    // the smoothing rounds the foot and the top of the climb by a sample or two
    expect(d1.climb!.startM).toBeGreaterThanOrEqual(5_800);
    expect(d1.climb!.startM).toBeLessThanOrEqual(6_200);
    expect(d1.climb!.gainM).toBeGreaterThanOrEqual(560);
    expect(d1.climb!.gainM).toBeLessThanOrEqual(600);
    expect(d1.climb!.lengthM).toBeGreaterThanOrEqual(5_600);
    expect(d1.climb!.lengthM).toBeLessThanOrEqual(6_200);
    // day 2 only descends: no climb worth naming
    expect(dayFacts(profile, ROUTE_M, ranges[1]!)!.climb).toBeUndefined();
  });

  it("finds the climb's foot on a noisy flat approach, not the deepest wobble before it", () => {
    // The ±4 m the ascent filter is calibrated against (tests/gpx.test.ts), on the same
    // ground. The run opens wherever the flat last touched a new low, which under noise
    // is a wobble anywhere in the first 6 km; the foot has to be read off the series
    // against the threshold, or the climb reads as starting at the trailhead.
    const noisy = profile.map((e, i) => e + (i % 2 ? 4 : -4));
    const d1 = dayFacts(noisy, ROUTE_M, ranges[0]!)!;
    expect(d1.climb!.startM).toBeGreaterThanOrEqual(5_500);
    expect(d1.climb!.startM).toBeLessThanOrEqual(6_200);
    expect(d1.climb!.lengthM).toBeGreaterThanOrEqual(5_600);
    expect(d1.climb!.lengthM).toBeLessThanOrEqual(6_800);
    expect(d1.climb!.gainM).toBeGreaterThanOrEqual(560);
    expect(d1.climb!.gainM).toBeLessThanOrEqual(610);
  });

  it("scales the climb's gain by the route's full-resolution ascent, as the day's climb figure is", () => {
    // the profile's own climb is 600 m; the track measured 660 m
    const d1 = dayFacts(profile, ROUTE_M, ranges[0]!, 660)!;
    expect(d1.climb!.gainM).toBeGreaterThanOrEqual(616);
    expect(d1.climb!.gainM).toBeLessThanOrEqual(660);
    // heights are NOT scaled: a summit is where the samples say it is
    expect(d1.campM).toBe(1600);
  });

  it("finds the steepest stretch, signed, and says where it is", () => {
    const d1 = dayFacts(profile, ROUTE_M, ranges[0]!)!;
    expect(d1.steepest!.gradePct).toBe(10);
    expect(d1.steepest!.atM).toBeGreaterThan(6_000);
    expect(d1.steepest!.atM).toBeLessThan(12_000);
    const d2 = dayFacts(profile, ROUTE_M, ranges[1]!)!;
    expect(d2.steepest!.gradePct).toBe(-10);
  });

  it("says nothing on flat ground rather than naming a 0% stretch or a 0 m climb", () => {
    const flat = Array.from({ length: 241 }, () => 1000);
    const d = dayFacts(flat, ROUTE_M, ranges[0]!)!;
    expect(d.climb).toBeUndefined();
    expect(d.steepest).toBeUndefined();
    expect(d.campM).toBe(1000);
  });

  it("is null without a profile, a route length, or a day that owns ground", () => {
    expect(dayFacts([], ROUTE_M, ranges[0]!)).toBeNull();
    expect(dayFacts([1000], ROUTE_M, ranges[0]!)).toBeNull();
    expect(dayFacts(profile, undefined, ranges[0]!)).toBeNull();
    expect(dayFacts(profile, 0, ranges[0]!)).toBeNull();
    expect(dayFacts(profile, ROUTE_M, { fromM: 12_000, toM: 12_000 })).toBeNull();
  });

  it("interpolates a camp between samples and clamps a day that runs past the route", () => {
    // 6,050 m is halfway between the 1,000 m sample at 6.0 km and 1,010 m at 6.1 km
    const d = dayFacts(profile, ROUTE_M, { fromM: 0, toM: 6_050 })!;
    expect(d.campM).toBeCloseTo(1005, 6);
    const past = dayFacts(profile, ROUTE_M, { fromM: 20_000, toM: 30_000 })!;
    expect(past.campM).toBe(1200);
  });

  it("ignores a climb too small to name", () => {
    // a 20 m bump on otherwise flat ground
    const bump = Array.from({ length: 241 }, (_, i) => (i >= 100 && i <= 110 ? 1000 + (i - 100) * 2 : i > 110 && i <= 120 ? 1020 - (i - 110) * 2 : 1000));
    expect(dayFacts(bump, ROUTE_M, ranges[0]!)!.climb).toBeUndefined();
  });
});

describe("coolerByC", () => {
  it("is the environmental lapse rate: 6.5 °C per kilometre, signed", () => {
    expect(coolerByC(1000)).toBeCloseTo(6.5, 6);
    expect(coolerByC(-400)).toBeCloseTo(-2.6, 6);
    expect(coolerByC(0)).toBe(0);
  });
});
