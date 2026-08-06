import { describe, expect, it } from "vitest";
import { PROFILE_SAMPLES, gpxStats, haversineM, parseProfile, profileToString, segmentClimbs, type TrackPoint } from "../shared/gpx";

// A track that walks due east along a parallel, so the distances are easy to reason
// about: at the equator 0.001° of longitude is ~111 m.
const eastward = (n: number, ele?: (i: number) => number): TrackPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ...(ele ? { ele: ele(i) } : {}),
  }));

describe("haversineM", () => {
  it("measures a known separation", () => {
    // one degree of latitude is ~111.2 km anywhere
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111_195, -2);
  });

  it("is zero for a point against itself", () => {
    expect(haversineM({ lat: 47.5, lon: -121.7 }, { lat: 47.5, lon: -121.7 })).toBe(0);
  });
});

describe("gpxStats — distance", () => {
  it("sums the legs", () => {
    const s = gpxStats(eastward(11))!;
    // 10 legs of ~111 m
    expect(s.distanceM).toBeGreaterThan(1090);
    expect(s.distanceM).toBeLessThan(1120);
    expect(s.pointCount).toBe(11);
  });

  it("declines a track that isn't one", () => {
    expect(gpxStats([])).toBeNull();
    expect(gpxStats([{ lat: 0, lon: 0 }])).toBeNull();
    // two points in the same place have no length
    expect(gpxStats([{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }])).toBeNull();
  });
});

describe("gpxStats — ascent, and the noise that would ruin it", () => {
  it("all but ignores GPS jitter on flat ground", () => {
    // THE test this file exists for. A flat 22 km walk recorded with ±4 m of noise:
    // summed naively it "climbs" 800 m, and that number would feed straight into the time
    // and calorie estimates, which are most sensitive to climb.
    //
    // The bar is NEGLIGIBLE, not zero, and that's deliberate. Demanding an exact zero on
    // this artificial square wave is what pushed the threshold up to 10 m — which then
    // cost ~10% of the real climb on an actual alpine loop. A few metres of residue
    // across 22 km changes no estimate anyone will read; ten per cent of a day's ascent
    // does. Tuned against the real track, checked for sanity here.
    const noisy = eastward(200, (i) => 1000 + (i % 2 ? 4 : -4));
    const s = gpxStats(noisy)!;
    expect(s.ascentM).toBeLessThan(10);
    expect(s.descentM).toBeLessThan(10);
  });

  it("still counts a real, steady climb, near enough in full", () => {
    // 100 points rising 10 m each — a genuine 990 m climb.
    // It comes back 978, not 990: the smoother is edge-clamped, so the first and last
    // couple of points average against repeats of themselves and the very ends of the
    // climb flatten slightly. That's ~1% on a 990 m ascent, and it is the price of not
    // counting several hundred metres of noise on a flat walk. Asserted as a band rather
    // than a figure, because the exact loss is a property of the window size.
    const s = gpxStats(eastward(100, (i) => 1000 + i * 10))!;
    expect(s.ascentM).toBeGreaterThan(990 * 0.97);
    expect(s.ascentM).toBeLessThanOrEqual(990);
    expect(s.descentM).toBe(0);
  });

  it("counts a climb that arrives in small steps, once it clears the threshold", () => {
    // 1 m per point: below the threshold individually, but the reference doesn't move
    // until it's cleared, so the climb still accumulates rather than vanishing
    // 90 exactly: nine commits of 10 m, with the trailing 10 m never clearing the
    // threshold. Under-reads by a step at the end, which is the right direction to be
    // wrong — it can't invent climb that isn't there.
    const s = gpxStats(eastward(101, (i) => 1000 + i))!;
    expect(s.ascentM).toBeGreaterThanOrEqual(90);
    expect(s.ascentM).toBeLessThanOrEqual(100);
  });

  it("separates up from down", () => {
    // up 500, then down 300
    const s = gpxStats(eastward(101, (i) => (i <= 50 ? 1000 + i * 10 : 1500 - (i - 50) * 6)))!;
    expect(s.ascentM).toBeGreaterThan(450);
    expect(s.descentM).toBeGreaterThan(250);
    expect(s.descentM).toBeLessThan(s.ascentM);
  });

  it("reports the range it actually spanned", () => {
    const s = gpxStats(eastward(50, (i) => 800 + i * 20))!;
    expect(s.minEleM).toBe(800);
    expect(s.maxEleM).toBe(1780);
  });

  it("says nothing about climb when the track carries no elevation", () => {
    const s = gpxStats(eastward(20))!;
    expect(s.ascentM).toBe(0);
    expect(s.profile).toEqual([]);
  });
});

describe("gpxStats — the profile", () => {
  it("returns a fixed number of samples regardless of track length", () => {
    for (const n of [10, 500, 5000]) {
      expect(gpxStats(eastward(n, (i) => 1000 + i))!.profile).toHaveLength(PROFILE_SAMPLES);
    }
  });

  it("starts and ends on the track's own elevations", () => {
    const p = gpxStats(eastward(200, (i) => 500 + i * 3))!.profile;
    expect(p[0]).toBe(500);
    expect(p[p.length - 1]).toBe(500 + 199 * 3);
  });

  it("samples by DISTANCE, not by point index", () => {
    // Half the points crowd into the first tenth of the ground — a recorder logging at a
    // fixed rate while you crawl uphill, then stride down. Sampled by index the midpoint
    // would land in that crowd; sampled by distance it lands near the middle of the walk.
    const pts: TrackPoint[] = [];
    for (let i = 0; i < 50; i++) pts.push({ lat: 0, lon: i * 0.0001, ele: 1000 });
    for (let i = 1; i <= 50; i++) pts.push({ lat: 0, lon: 0.005 + i * 0.0018, ele: 2000 });
    const p = gpxStats(pts)!.profile;
    // by index the middle would still read ~1000; by distance the walk is mostly the
    // second stretch, so the middle sits at the higher elevation
    expect(p[Math.floor(PROFILE_SAMPLES / 2)]).toBe(2000);
  });
});

describe("profile storage", () => {
  it("round-trips", () => {
    const p = [1000, 1010, 1025, 990];
    expect(parseProfile(profileToString(p))).toEqual(p);
  });

  it("has nothing to store for an empty profile", () => {
    expect(profileToString([])).toBeUndefined();
  });

  it("refuses anything that isn't a profile", () => {
    expect(parseProfile(undefined)).toEqual([]);
    expect(parseProfile("")).toEqual([]);
    expect(parseProfile("1000,abc")).toEqual([]);
    expect(parseProfile("1000")).toEqual([]); // one point is not a shape
    expect(parseProfile("1000,99999")).toEqual([]); // above the troposphere
    expect(parseProfile("1000,-9999")).toEqual([]); // below the Dead Sea
    expect(parseProfile("1,".repeat(3000))).toEqual([]); // past the stored bound
  });
});

describe("segmentClimbs — a day's climb, read off the route", () => {
  it("attributes the climb to the stretch it happens on", () => {
    // flat, then a 1,000 m climb, then flat
    const profile = [
      ...Array.from({ length: 32 }, () => 1000),
      ...Array.from({ length: 32 }, (_, i) => 1000 + (i + 1) * 31.25),
      ...Array.from({ length: 32 }, () => 2000),
    ];
    const [a, b, c] = segmentClimbs(profile, [1, 1, 1]);
    expect(a!.ascentM).toBeLessThan(60);
    expect(b!.ascentM).toBeGreaterThan(850);
    expect(c!.ascentM).toBeLessThan(60);
  });

  it("sums to about the whole track's climb", () => {
    const profile = Array.from({ length: 96 }, (_, i) => 1000 + Math.sin(i / 6) * 200 + i * 5);
    const whole = gpxStats(
      profile.map((ele, i) => ({ lat: 0, lon: i * 0.001, ele })),
    )!.ascentM;
    const parts = segmentClimbs(profile, [1, 1, 1, 1]).reduce((s, x) => s + x.ascentM, 0);
    // not identical — the whole-track pass has its own edge effects — but close
    expect(parts).toBeGreaterThan(whole * 0.9);
    expect(parts).toBeLessThan(whole * 1.1);
  });

  it("weights by each stretch's share of the ground, not by count", () => {
    // the climb is all in the first tenth
    const profile = [
      ...Array.from({ length: 10 }, (_, i) => 1000 + i * 100),
      ...Array.from({ length: 86 }, () => 1900),
    ];
    const [first, second] = segmentClimbs(profile, [10, 90]);
    expect(first!.ascentM).toBeGreaterThan(second!.ascentM);
  });

  it("has nothing to say without a profile", () => {
    expect(segmentClimbs([], [1, 1])).toEqual([
      { ascentM: 0, descentM: 0 },
      { ascentM: 0, descentM: 0 },
    ]);
  });
});
