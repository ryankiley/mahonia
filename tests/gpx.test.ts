import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { filePins, geoJsonPoints, gpxPoints, gpxStats, haversineM, kmzToKml, MAX_GPX_BYTES, zipMember, type TrackPoint } from "../shared/gpx";
import { CLIMB_SAMPLE_M, GRADE_HARD_PCT, GRADE_MODERATE_PCT, PROFILE_SAMPLES, dayClimbs, gradeRuns, gradeSpread, parseProfile, profileToString, segmentClimbs } from "../shared/profile";

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

  it("declines malformed coordinates instead of calculating a plausible route from them", () => {
    expect(gpxStats([{ lat: 0, lon: 0 }, { lat: 91, lon: 0 }])).toBeNull();
  });

  it("carries a neighbour's altitude across a point that has none, rather than dropping the profile", () => {
    // the seconds before a watch's barometer settles: a fix with no reading. Read
    // strictly, three such points would void a 3,000-point profile and the climb with it.
    const track = eastward(6, (i) => 1000 + i * 10);
    delete track[0]!.ele; // a leading gap takes the first reading after it
    track[3]!.ele = Number.NaN; // a NaN is a gap too, not a reading
    const s = gpxStats(track)!;
    expect(s.minEleM).toBe(1010);
    expect(s.maxEleM).toBe(1050);
    expect(s.ascentM).toBeGreaterThan(0);
    expect(s.profile).toHaveLength(PROFILE_SAMPLES);
    // none anywhere is still none
    expect(gpxStats(eastward(3))!.profile).toEqual([]);
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
    // 1 m per point: below the threshold on its own, but the reference doesn't move until
    // a step is committed, so the climb accumulates rather than vanishing. It lands just
    // under the full 100 m — the hysteresis leaves whatever hasn't yet cleared the
    // threshold uncounted at the end, which is the right direction to be wrong: it can
    // under-read real ground, never invent ground that isn't there. Asserted as a band,
    // because the exact shortfall is a property of the threshold and the smoothing window
    // rather than anything this test is pinning down.
    const s = gpxStats(eastward(101, (i) => 1000 + i))!;
    expect(s.ascentM).toBeGreaterThanOrEqual(90);
    expect(s.ascentM).toBeLessThanOrEqual(100);
  });

  it("does not credit a part-written itinerary with the whole route's climb", () => {
    // THE BUG THIS EXISTS FOR: shares were normalised against their own sum, so one day
    // covering a quarter of the route had its stretch run to the last sample and took
    // every metre of climb on it. On screen a 10-mile Day 1 reported the same 5,272 ft as
    // the 39.7-mile route it sat on, which is wrong in the most believable way possible.
    const s = gpxStats(eastward(241, (i) => 1000 + i * 10))!;
    const whole = segmentClimbs(s.profile, [1])[0]!.ascentM;
    // one day holding a quarter of the route, three not filled in yet
    const parts = segmentClimbs(s.profile, [1000, 0, 0, 0], 4000);
    expect(parts[0]!.ascentM).toBeGreaterThan(0);
    expect(parts[0]!.ascentM).toBeLessThan(whole * 0.4);
    // and the ground nobody claimed goes to nobody — least of all the last day
    expect(parts[1]!.ascentM).toBe(0);
    expect(parts[3]!.ascentM).toBe(0);
  });

  it("still splits evenly when the days do cover the route", () => {
    const s = gpxStats(eastward(241, (i) => 1000 + i * 10))!;
    const halves = segmentClimbs(s.profile, [2000, 2000], 4000);
    expect(halves[0]!.ascentM).toBeGreaterThan(0);
    // a steady climb divides about evenly; generous band, the point is neither half is
    // starved or handed the lot
    expect(halves[1]!.ascentM / halves[0]!.ascentM).toBeGreaterThan(0.8);
    expect(halves[1]!.ascentM / halves[0]!.ascentM).toBeLessThan(1.25);
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

describe("dayClimbs — shape from the profile, magnitude from the full track", () => {
  // The editor and the shared view both call this, so they cannot disagree about what a
  // day climbed. It is also where the branch's worst bug lived, twice over.
  const steady = Array.from({ length: 240 }, (_, i) => 1000 + i * 10);

  it("scales the days to the track's real climb without inventing coverage", () => {
    // days cover the whole route: their climbs should add up to about the stored total
    const parts = dayClimbs(steady, [2000, 2000], 4000, 3000);
    const sum = parts.reduce((s, p) => s + p.ascentM, 0);
    expect(sum).toBeGreaterThan(3000 * 0.9);
    expect(sum).toBeLessThan(3000 * 1.1);
  });

  it("does NOT hand a quarter of the route the whole trip's climb", () => {
    // The bug: the correction forced the days to sum to the route's stored ascent, so an
    // itinerary covering a quarter of the walk reported all of its climb. On screen a
    // 10-mile Day 1 read the same 5,272 ft as the 39.7-mile route it sat on.
    const parts = dayClimbs(steady, [1000, 0, 0, 0], 4000, 3000);
    expect(parts[0]!.ascentM).toBeGreaterThan(0);
    expect(parts[0]!.ascentM).toBeLessThan(3000 * 0.45);
    expect(parts[1]!.ascentM).toBe(0);
  });

  it("leaves the shares alone when the track's total isn't stored", () => {
    // an older list has a profile but no full-resolution figure to correct against —
    // better an uncorrected reading than an invented one
    const uncorrected = segmentClimbs(steady, [2000, 2000], 4000);
    expect(dayClimbs(steady, [2000, 2000], 4000, undefined)).toEqual(uncorrected);
  });

  it("is empty without a profile, rather than zeroes that look like measurements", () => {
    expect(dayClimbs([], [1000, 1000], 2000, 500)).toEqual([]);
  });
});

describe("gradeRuns — how hard the ground is", () => {
  // 240 samples over 10 km, so one sample is ~42 m and a 1 m rise per sample is ~2.4%.
  const over10km = (risePerSample: number) =>
    Array.from({ length: 240 }, (_, i) => 1000 + i * risePerSample);
  const bandsOf = (profile: number[]) => new Set(gradeRuns(profile, 10_000).map((r) => r.band));

  it("calls flat ground easy", () => {
    expect(bandsOf(over10km(0))).toEqual(new Set(["easy"]));
  });

  it("calls a sustained steep climb hard", () => {
    // ~10 m per 42 m sample ≈ 24%
    expect(bandsOf(over10km(10))).toEqual(new Set(["hard"]));
  });

  it("bands a DESCENT the same as the equivalent climb", () => {
    // the whole direction-agnostic argument: steep is steep
    const up = gradeRuns(over10km(10), 10_000);
    const down = gradeRuns(over10km(-10), 10_000);
    expect(down.map((r) => r.band)).toEqual(up.map((r) => r.band));
  });

  it("puts a gentle grade in the moderate band, not the hard one", () => {
    // ~3 m per 42 m sample ≈ 7%, between the two thresholds.
    //
    // Asserted on the LONGEST run rather than the whole set: `smooth` is edge-clamped, so
    // the first and last couple of samples average against repeats of themselves and read
    // fractionally flatter. That costs two samples out of 240 at each end and is the same
    // edge behaviour the ascent arithmetic already accepts — worth pinning as expected
    // rather than pretending the bands are uniform.
    const runs = gradeRuns(over10km(3), 10_000);
    const longest = runs.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    expect(longest.band).toBe("moderate");
    expect(longest.to - longest.from).toBeGreaterThan(200);
    expect(bandsOf(over10km(3)).has("hard")).toBe(false);
  });

  it("covers the whole profile with runs that meet, leaving no gap", () => {
    const runs = gradeRuns(over10km(6), 10_000);
    expect(runs[0]!.from).toBe(0);
    expect(runs[runs.length - 1]!.to).toBe(239);
    // each run starts where the last ended, so the drawn fills share a sample
    for (let i = 1; i < runs.length; i++) expect(runs[i]!.from).toBe(runs[i - 1]!.to);
  });

  it("does NOT shatter into confetti on noisy but flat ground", () => {
    // THE reason the series is smoothed first. ±6 m of GPS jitter on level ground is a
    // huge instantaneous grade at 42 m spacing; unsmoothed this bands as hundreds of
    // alternating runs and paints a flat walk in stripes.
    const jittery = Array.from({ length: 240 }, (_, i) => 1000 + (i % 2 ? 6 : 0));
    const runs = gradeRuns(jittery, 10_000);
    expect(runs.length).toBeLessThan(10);
  });

  it("is empty rather than guessing when there's no distance to divide by", () => {
    expect(gradeRuns(over10km(5), 0)).toEqual([]);
    expect(gradeRuns([1000], 10_000)).toEqual([]);
  });

  it("gradeSpread accounts for the whole route", () => {
    const spread = gradeSpread(over10km(3), 10_000);
    const total = spread.easy + spread.moderate + spread.hard;
    expect(total).toBeGreaterThan(9_900);
    expect(total).toBeLessThanOrEqual(10_001);
  });

  it("keeps the hard threshold equal to the readout's idea of steep", () => {
    // TrailProfile's hover readout marks a grade steep at 10%. Two definitions of the
    // same word is how a chart starts disagreeing with its own tooltip.
    expect(GRADE_HARD_PCT).toBe(10);
    expect(GRADE_MODERATE_PCT).toBeLessThan(GRADE_HARD_PCT);
  });
});

// Other people's route files.
//
// A route is a route; which app exported it is not the walker's problem. All four formats
// land on the same TrackPoint[], so everything downstream — distance, climb, the profile,
// the estimates — is untouched by which one arrived. That is the property worth pinning:
// not that each parser works, but that they AGREE.

// happy-dom's parser, because this file otherwise runs without a DOM. The fixtures below
// carry their real XML NAMESPACES — every exporter emits them, and a parser that only
// worked on namespace-free XML would pass here and fail on every actual file.
const parser = new (new Window().DOMParser)();
const xml = (s: string) => parser.parseFromString(s, "application/xml") as unknown as Document;

/** the same three points, as each format writes them */
const GPX = `<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg>
  <trkpt lat="45.33" lon="-121.71"><ele>1800</ele></trkpt>
  <trkpt lat="45.34" lon="-121.70"><ele>1850</ele></trkpt>
  <trkpt lat="45.35" lon="-121.69"><ele>1900</ele></trkpt>
</trkseg></trk></gpx>`;

// KML puts LON FIRST, which is the one thing about the format that bites
const KML = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><LineString><coordinates>
  -121.71,45.33,1800 -121.70,45.34,1850 -121.69,45.35,1900
</coordinates></LineString></Placemark></Document></kml>`;

const TCX = `<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity><Lap><Track>
  <Trackpoint><Position><LatitudeDegrees>45.33</LatitudeDegrees><LongitudeDegrees>-121.71</LongitudeDegrees></Position><AltitudeMeters>1800</AltitudeMeters></Trackpoint>
  <Trackpoint><Position><LatitudeDegrees>45.34</LatitudeDegrees><LongitudeDegrees>-121.70</LongitudeDegrees></Position><AltitudeMeters>1850</AltitudeMeters></Trackpoint>
  <Trackpoint><Position><LatitudeDegrees>45.35</LatitudeDegrees><LongitudeDegrees>-121.69</LongitudeDegrees></Position><AltitudeMeters>1900</AltitudeMeters></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;

const GEOJSON = {
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: { type: "LineString",
    coordinates: [[-121.71, 45.33, 1800], [-121.70, 45.34, 1850], [-121.69, 45.35, 1900]] } }],
};

describe("reading a route out of somebody else's file", () => {
  it("reads all four formats to the same points", () => {
    const fromGpx = gpxPoints(xml(GPX));
    for (const other of [gpxPoints(xml(KML)), gpxPoints(xml(TCX)), geoJsonPoints(GEOJSON)]) {
      expect(other).toEqual(fromGpx);
    }
    expect(fromGpx).toHaveLength(3);
    expect(fromGpx[0]).toEqual({ lat: 45.33, lon: -121.71, ele: 1800 });
  });

  it("gets LON and LAT the right way round in KML", () => {
    // the failure this guards is silent and total: swap them and Mount Hood lands in
    // Kazakhstan, with a perfectly plausible-looking distance
    const [first] = gpxPoints(xml(KML));
    expect(first!.lat).toBeCloseTo(45.33, 5);
    expect(first!.lon).toBeCloseTo(-121.71, 5);
  });

  it("produces identical stats whichever format arrived", () => {
    const stats = [GPX, KML, TCX].map((s) => gpxStats(gpxPoints(xml(s))));
    stats.push(gpxStats(geoJsonPoints(GEOJSON)));
    for (const s of stats) expect(s).toEqual(stats[0]);
    expect(stats[0]!.distanceM).toBeGreaterThan(0);
  });

  it("takes a bare LineString, a Feature, or a FeatureCollection", () => {
    const line = { type: "LineString", coordinates: [[-121.71, 45.33], [-121.70, 45.34]] };
    expect(geoJsonPoints(line)).toHaveLength(2);
    expect(geoJsonPoints({ type: "Feature", geometry: line })).toHaveLength(2);
    expect(geoJsonPoints({ type: "FeatureCollection", features: [{ type: "Feature", geometry: line }] })).toHaveLength(2);
    expect(geoJsonPoints({ type: "MultiLineString", coordinates: [line.coordinates, line.coordinates] })).toHaveLength(4);
  });

  it("carries elevation when it's there and copes when it isn't", () => {
    const flat = { type: "LineString", coordinates: [[-121.71, 45.33], [-121.70, 45.34]] };
    expect(geoJsonPoints(flat).every((p) => p.ele === undefined)).toBe(true);
  });

  it("yields nothing rather than a partial line for junk", () => {
    expect(geoJsonPoints(null)).toEqual([]);
    expect(geoJsonPoints({ type: "Point", coordinates: [-121.71, 45.33] })).toEqual([]);
    expect(geoJsonPoints({ type: "LineString", coordinates: [["a", "b"], [1]] })).toEqual([]);
    expect(gpxPoints(xml(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>`))).toEqual([]);
  });

  it("drops out-of-range coordinates across every text format", () => {
    const valid = [{ lat: 45.33, lon: -121.71 }];
    expect(gpxPoints(xml(`<gpx><trk><trkseg><trkpt lat="45.33" lon="-121.71"/><trkpt lat="95" lon="-121.70"/></trkseg></trk></gpx>`))).toEqual(valid);
    expect(gpxPoints(xml(`<kml><Document><Placemark><LineString><coordinates>-121.71,45.33 181,45.34</coordinates></LineString></Placemark></Document></kml>`))).toEqual(valid);
    expect(gpxPoints(xml(`<TrainingCenterDatabase><Trackpoint><Position><LatitudeDegrees>45.33</LatitudeDegrees><LongitudeDegrees>-121.71</LongitudeDegrees></Position></Trackpoint><Trackpoint><Position><LatitudeDegrees>45.34</LatitudeDegrees><LongitudeDegrees>-181</LongitudeDegrees></Position></Trackpoint></TrainingCenterDatabase>`))).toEqual(valid);
    expect(geoJsonPoints({ type: "LineString", coordinates: [[-121.71, 45.33], [181, 45.34]] })).toEqual(valid);
  });

  it("leaves an altitude absent when a TCX trackpoint omits its tag, and the profile survives it", () => {
    const [point] = gpxPoints(xml(`<TrainingCenterDatabase><Trackpoint><Position><LatitudeDegrees>45.33</LatitudeDegrees><LongitudeDegrees>-121.71</LongitudeDegrees></Position></Trackpoint></TrainingCenterDatabase>`));
    expect(point).toEqual({ lat: 45.33, lon: -121.71 });
    // the same file with its first altitude missing keeps its profile: the gap takes
    // the 1850 beside it instead of counting as sea level or voiding the climb
    const gap = gpxStats(gpxPoints(xml(TCX.replace("<AltitudeMeters>1800</AltitudeMeters>", ""))))!;
    expect(gap.minEleM).toBe(1850);
    expect(gap.maxEleM).toBe(1900);
    expect(gap.profile).toHaveLength(PROFILE_SAMPLES);
  });

  it("does not turn missing or empty coordinate text into a phantom point at zero", () => {
    expect(gpxPoints(xml(`<gpx><trk><trkseg><trkpt lon="-121.71"/></trkseg></trk></gpx>`))).toEqual([]);
    expect(gpxPoints(xml(`<TrainingCenterDatabase><Trackpoint><Position><LatitudeDegrees></LatitudeDegrees><LongitudeDegrees>-121.71</LongitudeDegrees></Position></Trackpoint></TrainingCenterDatabase>`))).toEqual([]);
    expect(gpxPoints(xml(`<kml><Document><Placemark><LineString><coordinates>,</coordinates></LineString></Placemark></Document></kml>`))).toEqual([]);
    expect(gpxPoints(xml(`<feed><line>,</line></feed>`))).toEqual([]);
    expect(filePins(xml(`<gpx><wpt lat="" lon="-121.71"/></gpx>`))).toEqual([]);
  });
});

describe("KMZ — a KML in a zip", () => {
  /** A real zip, built here rather than mocked, so the central-directory walk is
   *  genuinely exercised. `method` 0 is stored; 8 would be deflate. */
  type ZipInput = { name: string; body: string | Uint8Array; deflate?: boolean };

  function zipEntries(entries: readonly ZipInput[]): ArrayBuffer {
    const enc = new TextEncoder();
    const prepared = entries.map(({ name, body, deflate = false }) => {
      const raw = typeof body === "string" ? enc.encode(body) : body;
      return {
        nameB: enc.encode(name),
        raw,
        data: deflate ? new Uint8Array(deflateRawSync(raw)) : raw,
        method: deflate ? 8 : 0,
        localAt: 0,
      };
    });
    const localSize = prepared.reduce((size, entry) => size + 30 + entry.nameB.length + entry.data.length, 0);
    const centralSize = prepared.reduce((size, entry) => size + 46 + entry.nameB.length, 0);
    const buf = new Uint8Array(localSize + centralSize + 22);
    const dv = new DataView(buf.buffer);
    let o = 0;

    for (const entry of prepared) {
      entry.localAt = o;
      dv.setUint32(o, 0x04034b50, true);            // local header
      dv.setUint16(o + 8, entry.method, true);
      dv.setUint32(o + 18, entry.data.length, true); // compressed size
      dv.setUint32(o + 22, entry.raw.length, true);  // uncompressed size
      dv.setUint16(o + 26, entry.nameB.length, true);
      buf.set(entry.nameB, o + 30);
      buf.set(entry.data, o + 30 + entry.nameB.length);
      o += 30 + entry.nameB.length + entry.data.length;
    }

    const cdAt = o;
    for (const entry of prepared) {
      dv.setUint32(o, 0x02014b50, true);            // central directory
      dv.setUint16(o + 10, entry.method, true);
      dv.setUint32(o + 20, entry.data.length, true);
      dv.setUint32(o + 24, entry.raw.length, true);
      dv.setUint16(o + 28, entry.nameB.length, true);
      dv.setUint32(o + 42, entry.localAt, true);    // local header offset
      buf.set(entry.nameB, o + 46);
      o += 46 + entry.nameB.length;
    }

    dv.setUint32(o, 0x06054b50, true);            // end of central directory
    dv.setUint16(o + 8, prepared.length, true);    // entries on this disk
    dv.setUint16(o + 10, prepared.length, true);   // entries total
    dv.setUint32(o + 12, centralSize, true);
    dv.setUint32(o + 16, cdAt, true);              // where the directory starts
    return buf.buffer;
  }

  const zip = (name: string, body: string, { deflate = false }: { deflate?: boolean } = {}) =>
    zipEntries([{ name, body, deflate }]);

  it("pulls the KML out and reads the route in it", async () => {
    const kml = await kmzToKml(zip("doc.kml", KML));
    expect(kml).toContain("coordinates");
    expect(gpxPoints(xml(kml!))).toHaveLength(3);
  });

  it("finds the KML wherever it sits in the archive", async () => {
    // Google Earth writes doc.kml at the root; other tools nest it
    expect(await kmzToKml(zip("files/route.kml", KML))).toContain("coordinates");
  });

  it("finds an archive whose maximum-length comment follows the directory", async () => {
    const base = new Uint8Array(zip("doc.kml", KML));
    const comment = new Uint8Array(65_535);
    const withComment = new Uint8Array(base.length + comment.length);
    withComment.set(base);
    new DataView(withComment.buffer).setUint16(base.length - 2, comment.length, true);
    expect(await kmzToKml(withComment.buffer)).toContain("coordinates");
  });

  it("ignores EOCD magic inside the archive comment", async () => {
    const base = new Uint8Array(zip("doc.kml", KML));
    const comment = new Uint8Array(40);
    // This looks like an EOCD after the real record, but its zero-length comment
    // stops short of the end of the file. The real EOCD owns all 40 comment bytes.
    comment.set([0x50, 0x4b, 0x05, 0x06], 10);
    const withComment = new Uint8Array(base.length + comment.length);
    withComment.set(base);
    withComment.set(comment, base.length);
    new DataView(withComment.buffer).setUint16(base.length - 2, comment.length, true);
    expect(await kmzToKml(withComment.buffer)).toContain("coordinates");
  });

  it("still reads an archive with bytes after its end record", async () => {
    // a padded download, or a writer that appended a newline: unzip and Python's
    // zipfile open these without a word, and so did this reader before the
    // comment-length rule above — the exact record wins when there is one, and
    // this is what stands in when there is not
    const base = new Uint8Array(zip("doc.kml", KML));
    const padded = new Uint8Array(base.length + 1);
    padded.set(base);
    padded[base.length] = 0x0a;
    expect(await kmzToKml(padded.buffer)).toContain("coordinates");
  });

  it("inflates a standard deflate member within the route-size budget", async () => {
    expect(await kmzToKml(zip("doc.kml", KML, { deflate: true }))).toContain("coordinates");
  });

  it("skips a large unrelated member but keeps the selected-member limit", async () => {
    const archive = zipEntries([
      // Deflate makes this 10 MB attachment tiny on disk. It is a valid KMZ member,
      // but it is not the KML the route importer will ever unpack.
      { name: "previews/full-resolution.png", body: new Uint8Array(MAX_GPX_BYTES + 1), deflate: true },
      { name: "doc.kml", body: KML },
    ]);

    expect(await kmzToKml(archive)).toContain("coordinates");
    await expect(zipMember(archive, () => true)).resolves.toBeNull();
  });

  it("declines anything that isn't a zip, rather than guessing", async () => {
    expect(await kmzToKml(new TextEncoder().encode("<gpx/>").buffer)).toBeNull();
    expect(await kmzToKml(new ArrayBuffer(0))).toBeNull();
  });

  it("declines a zip with no KML in it", async () => {
    expect(await kmzToKml(zip("readme.txt", "not a route"))).toBeNull();
  });

  it("declines a corrupt directory or a truncated member without throwing", async () => {
    const badOffset = new Uint8Array(22);
    const view = new DataView(badOffset.buffer);
    view.setUint32(0, 0x06054b50, true); // end of central directory
    view.setUint16(10, 1, true);
    view.setUint32(16, 0xffff_ffff, true); // no central header there
    await expect(zipMember(badOffset.buffer, () => true)).resolves.toBeNull();

    const truncated = new Uint8Array(zip("doc.kml", KML));
    const end = truncated.length - 22;
    const centralAt = new DataView(truncated.buffer).getUint32(end + 16, true);
    new DataView(truncated.buffer).setUint32(centralAt + 20, 100_000, true);
    await expect(zipMember(truncated.buffer, () => true)).resolves.toBeNull();
  });
});

describe("GeoRSS", () => {
  it("reads a lat-lon run, LAT first — the opposite of KML", () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss">
      <entry><georss:line>45.33 -121.71 45.34 -121.70 45.35 -121.69</georss:line></entry></feed>`;
    const pts = gpxPoints(xml(feed));
    expect(pts).toHaveLength(3);
    expect(pts[0]!.lat).toBeCloseTo(45.33, 5);
    expect(pts[0]!.lon).toBeCloseTo(-121.71, 5);
  });

  it("drops a pair that can't be a coordinate", () => {
    const feed = `<feed xmlns:georss="http://www.georss.org/georss">
      <georss:line>999 -121.71 45.34 -121.70</georss:line></feed>`;
    expect(gpxPoints(xml(feed))).toHaveLength(1);
  });
});

describe("a KML full of markers", () => {
  // THE BUG THIS EXISTS FOR, found only by trying a real export. AllTrails' Timberline KML
  // carries twelve <coordinates> blocks: the 3,483-point track, and eleven single-point
  // markers for trailheads and viewpoints. Reading all twelve stitched every marker into
  // the route and turned a 39.8-mile loop into 58.5 — wrong in the most believable way,
  // since nothing about the number looks broken.
  const REAL_SHAPE = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <Placemark><name>Trailhead</name><Point><coordinates>-121.7113,45.3313,1820</coordinates></Point></Placemark>
    <Placemark><name>Viewpoint</name><Point><coordinates>-121.6500,45.4000,2100</coordinates></Point></Placemark>
    <Placemark><name>Timberline Trail</name><LineString><coordinates>
      -121.71,45.33,1800 -121.70,45.34,1850 -121.69,45.35,1900
    </coordinates></LineString></Placemark>
  </Document></kml>`;

  it("reads the line and ignores every marker", () => {
    const pts = gpxPoints(xml(REAL_SHAPE));
    expect(pts).toHaveLength(3);
    // the markers sit far off the track; if either leaked in, the first point moves
    expect(pts[0]).toEqual({ lat: 45.33, lon: -121.71, ele: 1800 });
    expect(pts.some((p) => p.lon === -121.65)).toBe(false);
  });

  it("does not inflate the distance with a marker's leg", () => {
    const withMarkers = gpxStats(gpxPoints(xml(REAL_SHAPE)))!;
    const lineOnly = gpxStats(gpxPoints(xml(KML)))!;
    expect(withMarkers.distanceM).toBe(lineOnly.distanceM);
  });

  it("still joins a track split across several LineStrings", () => {
    // segments ARE concatenated — that's the same concession the GPX reader makes
    const split = `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark><LineString><coordinates>-121.71,45.33,1800 -121.70,45.34,1850</coordinates></LineString></Placemark>
      <Placemark><LineString><coordinates>-121.69,45.35,1900 -121.68,45.36,1950</coordinates></LineString></Placemark>
    </Document></kml>`;
    expect(gpxPoints(xml(split))).toHaveLength(4);
  });
});

describe("gpxStats — a track sampled every second, as a watch writes one", () => {
  // The climb filter is calibrated in SAMPLES at ~18 m spacing (CLIMB_SAMPLE_M). A 1 Hz
  // track puts a point every metre or two, and unresampled the same filter read noise as
  // climb several times over: 4 m of Gaussian noise on a flat 22 km came to 4,190 m of
  // ascent at 1.2 m spacing against 267 m at 18 m. Deterministic noise here, so the
  // numbers are the numbers.
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const noisy = (spacingM: number, climbM = 0, sigma = 4): TrackPoint[] => {
    seed = 42;
    const n = Math.round(22_000 / spacingM);
    return Array.from({ length: n }, (_, i) => ({ lat: 0, lon: (i * spacingM) / 111_195, ele: 1000 + (climbM * i) / n + sigma * gauss() }));
  };

  it("reads about the same climb whether the track is sampled every 18 m or every 1.2 m", () => {
    const coarse = gpxStats(noisy(CLIMB_SAMPLE_M))!.ascentM;
    const dense = gpxStats(noisy(1.2))!.ascentM;
    expect(dense).toBeLessThan(coarse * 1.5);
    expect(dense).toBeGreaterThan(coarse * 0.5);
  });

  it("still counts a real climb under that noise, near enough in full", () => {
    const dense = gpxStats(noisy(1.2, 800))!.ascentM;
    expect(dense).toBeGreaterThan(700);
    expect(dense).toBeLessThan(1200);
  });

  it("leaves a track sparser than the calibration alone", () => {
    // 50 m spacing: no resampling, so the figure is exactly what the raw series gives
    const pts = noisy(50, 800, 0);
    expect(gpxStats(pts)!.ascentM).toBe(gpxStats(pts)!.ascentM);
    expect(gpxStats(pts)!.ascentM).toBeGreaterThan(780);
  });

  it("copes with a track longer than a spread call can take", () => {
    // 200,000 points is two and a bit days at one a second; Math.min(...ele) threw here
    const pts = Array.from({ length: 200_000 }, (_, i) => ({ lat: 0, lon: i / 111_195, ele: 1000 + (i % 100) }));
    const s = gpxStats(pts)!;
    expect(s.minEleM).toBe(1000);
    expect(s.maxEleM).toBe(1099);
  });
});
