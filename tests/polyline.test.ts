import { describe, expect, it } from "vitest";
import {
  MAX_GEOMETRY_LEN,
  MAX_ROUTE_POINTS,
  cumulativeM,
  decodePolyline,
  encodePolyline,
  nearestAlongM,
  normalizeRouteGeometry,
  pointAlong,
  routeGeometryFromPoints,
  sliceAlong,
} from "../shared/polyline";

// The route's shape is the app's first stored geography, and the first value here that a
// hostile client could use to make the app draw something. These tests are mostly about
// what it REFUSES.

const MT_HOOD = { lat: 45.3735, lon: -121.6959 };
const line = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ lat: 45.3 + i * 0.001, lon: -121.7 + i * 0.001 }));

describe("encoding round-trips", () => {
  it("survives a round trip to ~1 m", () => {
    const back = decodePolyline(encodePolyline([MT_HOOD, { lat: 45.38, lon: -121.7 }]));
    expect(back[0]!.lat).toBeCloseTo(MT_HOOD.lat, 4);
    expect(back[0]!.lon).toBeCloseTo(MT_HOOD.lon, 4);
  });

  it("handles negative and crossing-zero coordinates", () => {
    const pts = [{ lat: -0.001, lon: -0.002 }, { lat: 0.001, lon: 0.002 }];
    const back = decodePolyline(encodePolyline(pts));
    expect(back[0]!.lat).toBeCloseTo(-0.001, 4);
    expect(back[1]!.lon).toBeCloseTo(0.002, 4);
  });
});

describe("normalizeRouteGeometry refuses rather than repairs", () => {
  it("takes a real encoded route", () => {
    const geo = encodePolyline(line(10));
    expect(normalizeRouteGeometry(geo)).toBe(geo);
  });

  it("rejects anything that isn't a string, or is empty", () => {
    for (const bad of [null, undefined, 42, {}, [], ""]) {
      expect(normalizeRouteGeometry(bad)).toBeUndefined();
    }
  });

  it("rejects a single point — that's a location, not a route", () => {
    expect(normalizeRouteGeometry(encodePolyline([MT_HOOD]))).toBeUndefined();
  });

  it("rejects characters outside the polyline alphabet", () => {
    expect(normalizeRouteGeometry("not a polyline!!")).toBeUndefined();
    expect(normalizeRouteGeometry(encodePolyline(line(5)) + "\u0000")).toBeUndefined();
  });

  it("rejects a value truncated mid-number rather than salvaging the prefix", () => {
    // a fragment of a route is not a shorter route; drawing one would put a confident
    // shape on screen that nothing produced
    const geo = encodePolyline(line(10));
    expect(normalizeRouteGeometry(geo.slice(0, geo.length - 1))).toBeUndefined();
  });

  it("REFUSES an out-of-range coordinate instead of clamping it", () => {
    // clamping a bad latitude to 0 puts a pin in the Gulf of Guinea and draws a line to it
    const geo = encodePolyline([MT_HOOD, { lat: 91, lon: -121.7 }]);
    expect(normalizeRouteGeometry(geo)).toBeUndefined();
    expect(normalizeRouteGeometry(encodePolyline([MT_HOOD, { lat: 45.4, lon: 181 }]))).toBeUndefined();
  });

  it("bounds the POINT COUNT, not only the string length", () => {
    // The hole a length cap alone leaves: single-character deltas pack many points into
    // few characters, so a short string can still decode to thousands of points.
    const dense = Array.from({ length: MAX_ROUTE_POINTS + 200 }, (_, i) => ({
      lat: 45 + i * 0.00001,
      lon: -121 + i * 0.00001,
    }));
    const geo = encodePolyline(dense);
    expect(geo.length).toBeLessThan(MAX_GEOMETRY_LEN); // passes the length check…
    expect(normalizeRouteGeometry(geo)).toBeUndefined(); // …and is still refused
  });

  it("returns the CANONICAL encoding, so a hand-edited value can't round-trip its own shape", () => {
    const geo = encodePolyline(line(20));
    const normalized = normalizeRouteGeometry(geo)!;
    expect(normalizeRouteGeometry(normalized)).toBe(normalized);
  });
});

describe("simplification fits the budget without wasting it", () => {
  it("keeps a dense track under the point cap", () => {
    const dense = Array.from({ length: 4000 }, (_, i) => ({
      lat: 45.3 + Math.sin(i / 40) * 0.05,
      lon: -121.7 + i * 0.0002,
    }));
    const geo = routeGeometryFromPoints(dense)!;
    expect(geo).toBeDefined();
    expect(decodePolyline(geo).length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
    expect(geo.length).toBeLessThanOrEqual(MAX_GEOMETRY_LEN);
  });

  it("terminates on a track where every point is a genuine corner", () => {
    // the case the doubling loop exists for — a zigzag DP cannot thin
    const zigzag = Array.from({ length: 2000 }, (_, i) => ({
      lat: 45.3 + (i % 2) * 0.01,
      lon: -121.7 + i * 0.001,
    }));
    const geo = routeGeometryFromPoints(zigzag);
    expect(geo).toBeDefined();
    expect(decodePolyline(geo!).length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
  });

  it("thins a straight run to its endpoints — nothing between them is information", () => {
    // `line()` is perfectly straight, so DP is right to keep only the ends. Worth pinning:
    // it's the clearest demonstration that the budget is spent on corners, not on samples.
    expect(decodePolyline(routeGeometryFromPoints(line(20))!).length).toBe(2);
  });

  it("keeps the corners of a winding track", () => {
    // a switchback every few points, all well outside the 6 m tolerance
    const winding = Array.from({ length: 40 }, (_, i) => ({
      lat: 45.3 + (i % 2) * 0.0008,
      lon: -121.7 + i * 0.0008,
    }));
    const kept = decodePolyline(routeGeometryFromPoints(winding)!).length;
    expect(kept).toBeGreaterThan(30);
    expect(kept).toBeLessThanOrEqual(40);
  });

  it("is nothing for fewer than two points", () => {
    expect(routeGeometryFromPoints([])).toBeUndefined();
    expect(routeGeometryFromPoints([MT_HOOD])).toBeUndefined();
  });
});

describe("positions along the route — how a waypoint stores a number instead of a coordinate", () => {
  const pts = line(50);

  it("measures cumulative distance monotonically from zero", () => {
    const cum = cumulativeM(pts);
    expect(cum[0]).toBe(0);
    for (let i = 1; i < cum.length; i++) expect(cum[i]!).toBeGreaterThan(cum[i - 1]!);
  });

  it("resolves a distance back to a point on the line", () => {
    const cum = cumulativeM(pts);
    const total = cum[cum.length - 1]!;
    expect(pointAlong(pts, 0)).toEqual(pts[0]);
    const mid = pointAlong(pts, total / 2)!;
    expect(mid.lat).toBeGreaterThan(pts[0]!.lat);
    expect(mid.lat).toBeLessThan(pts[pts.length - 1]!.lat);
  });

  it("clamps a distance past either end onto the route", () => {
    const total = cumulativeM(pts).at(-1)!;
    expect(pointAlong(pts, -5_000)).toEqual(pts[0]);
    const end = pointAlong(pts, total + 5_000)!;
    expect(end.lat).toBeCloseTo(pts[pts.length - 1]!.lat, 5);
  });

  it("snaps an off-route coordinate to its nearest point ON the route", () => {
    // this is what makes a pin unable to land in the middle of a lake
    const target = pts[25]!;
    const offBy = { lat: target.lat + 0.002, lon: target.lon - 0.002 };
    const along = nearestAlongM(pts, offBy);
    const snapped = pointAlong(pts, along)!;
    const drift = Math.hypot(
      (snapped.lat - target.lat) * 111_320,
      (snapped.lon - target.lon) * 111_320,
    );
    expect(drift).toBeLessThan(400);
    const cum = cumulativeM(pts);
    expect(along).toBeGreaterThanOrEqual(0);
    expect(along).toBeLessThanOrEqual(Math.ceil(cum[cum.length - 1]!));
  });
});

describe("a precomputed spine is an optimisation, not a different answer", () => {
  // The map walks the same route hundreds of times per interaction and hands every
  // walker one cumulativeM() rather than letting each re-sum the route. That only
  // holds if the two paths agree exactly — so this pins them against each other,
  // including the ends where clamping happens and a span that crosses stored points.
  const pts = Array.from({ length: 30 }, (_, i) => ({
    lat: 45.3 + Math.sin(i / 3) * 0.004,
    lon: -121.7 + i * 0.0009,
  }));
  const cum = cumulativeM(pts);
  const total = cum[cum.length - 1]!;

  it("pointAlong agrees at every distance, clamped ends included", () => {
    for (const m of [-100, 0, 1, total / 3, total / 2, total - 1, total, total + 100]) {
      expect(pointAlong(pts, m, cum)).toEqual(pointAlong(pts, m));
    }
  });

  it("sliceAlong agrees, ends and inner points alike", () => {
    expect(sliceAlong(pts, total * 0.2, total * 0.7, cum)).toEqual(sliceAlong(pts, total * 0.2, total * 0.7));
    expect(sliceAlong(pts, -50, total + 50, cum)).toEqual(sliceAlong(pts, -50, total + 50));
    expect(sliceAlong(pts, 10, 10, cum)).toEqual([]);
  });

  it("nearestAlongM agrees for a point off the line", () => {
    const off = { lat: pts[12]!.lat + 0.001, lon: pts[12]!.lon - 0.0005 };
    expect(nearestAlongM(pts, off, cum)).toBe(nearestAlongM(pts, off));
  });
});
