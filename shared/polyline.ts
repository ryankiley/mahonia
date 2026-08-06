// The route's shape as coordinates — the app's first stored geography.
//
// Everything else about a route is a scalar: a length, a climb, 240 elevation samples with
// no position in them. This is different in kind, and the difference matters: a recorded
// GPX starts where the person parked, which is frequently where they live. So the encoding
// is bounded hard, validated like a hostile input, and kept off every read path that isn't
// the owner's (see rowToSnapshot).
//
// Google's encoded-polyline format, precision 5 (~1.1 m). Standard, decoded by everything,
// and roughly four characters per point on a simplified track. Precision 4 would save ~15%
// and introduce visible jitter on switchbacks; the savings belong in simplification
// instead, which is where they actually are.

/** ~1.1 m. The published default for this format, and finer than any hiking use needs. */
const PRECISION = 1e5;

/**
 * A point budget, not a length budget. 512 points across a 64 km route is one every 125 m,
 * which is sub-pixel when the whole route is on screen — and coarsens honestly as you zoom,
 * the same trade `trailProfile` already makes.
 */
export const MAX_ROUTE_POINTS = 512;

/**
 * A character bound as well, and it is NOT the same guard.
 *
 * A string cap alone does not bound the point count: 8192 characters of single-character
 * deltas decode to roughly 4,000 points. Both limits are checked, because either one alone
 * is a hole. (This is the lesson MAX_PROFILE_LEN only half-learned.)
 */
export const MAX_GEOMETRY_LEN = 8192;

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * How close a route's two ends have to be before it's the same place twice.
 *
 * 50 m is deliberately generous. A loop is walked, not computed: the track restarts at
 * whichever bit of the car park the GPS reacquired in, and a there-and-back doubles the
 * last hundred metres of trail without meaning to. Both should read as "you finish where
 * you started". A tighter threshold calls a genuine loop a point-to-point and stacks two
 * markers a few metres apart, which reads as a rendering fault rather than a fact.
 *
 * The cost of being wrong the other way is one deletable pin, so this errs loose.
 */
export const LOOP_CLOSE_M = 50;

/** Whether the route ends where it began — so a loop gets ONE end marker, not two on top
 *  of each other. */
export function isLoop(points: readonly LatLon[]): boolean {
  if (points.length < 3) return false;
  return approxM(points[0]!, points[points.length - 1]!) <= LOOP_CLOSE_M;
}

function encodeSigned(value: number, out: string[]): void {
  let v = value < 0 ? ~(value << 1) : value << 1;
  while (v >= 0x20) {
    out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    v >>= 5;
  }
  out.push(String.fromCharCode(v + 63));
}

/** Points → the stored string. Deltas, so a route's own length barely matters to the size. */
export function encodePolyline(points: readonly LatLon[]): string {
  const out: string[] = [];
  let lastLat = 0;
  let lastLon = 0;
  for (const p of points) {
    const lat = Math.round(p.lat * PRECISION);
    const lon = Math.round(p.lon * PRECISION);
    encodeSigned(lat - lastLat, out);
    encodeSigned(lon - lastLon, out);
    lastLat = lat;
    lastLon = lon;
  }
  return out.join("");
}

/**
 * The stored string → points, or `[]` for anything that isn't one.
 *
 * Refuses rather than repairs. A malformed run of characters is not a route with a bad
 * point in it; it is not a route, and drawing a line through a salvaged fragment of one
 * would put a confident shape on screen that nothing produced.
 */
export function decodePolyline(raw: string): LatLon[] {
  const out: LatLon[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < raw.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      if (i >= raw.length) return []; // truncated mid-value
      byte = raw.charCodeAt(i++) - 63;
      if (byte < 0 || byte > 63) return [];
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (shift > 35) return []; // a value no coordinate delta can need
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      if (i >= raw.length) return [];
      byte = raw.charCodeAt(i++) - 63;
      if (byte < 0 || byte > 63) return [];
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (shift > 35) return [];
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    out.push({ lat: lat / PRECISION, lon: lon / PRECISION });
  }
  return out;
}

/**
 * The single gate every write path runs a route through — the same posture parseProfile
 * takes with elevations, and for the same reason: this value reaches the DB from a GPX
 * read in a browser, from a JSON backup somebody hand-edited, and from a `setMeta` op a
 * hostile client can post directly.
 *
 * Out-of-range coordinates are REFUSED, never clamped. Clamping a bad latitude to 0 puts a
 * pin in the Gulf of Guinea and draws a line to it — junk rendered as terrain is worse
 * than nothing rendered at all.
 *
 * Returns the CANONICAL re-encoding rather than the input, so a hand-edited value can
 * never round-trip back out in a shape this codec didn't produce.
 */
export function normalizeRouteGeometry(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > MAX_GEOMETRY_LEN) return undefined;
  const points = decodePolyline(raw);
  if (points.length < 2 || points.length > MAX_ROUTE_POINTS) return undefined;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return undefined;
    if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180) return undefined;
  }
  return encodePolyline(points);
}

/** Metres in one degree of latitude. The two measurements below both scale by it, and
 *  they have to agree or a perpendicular distance stops matching the length it's judged
 *  against. */
const M_PER_DEG = 111_320;

/** Metres between two points — the flat-earth approximation, which is exact enough at the
 *  scale a simplification tolerance cares about and far cheaper than haversine per candidate. */
function approxM(a: LatLon, b: LatLon): number {
  const dx = (b.lon - a.lon) * M_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const dy = (b.lat - a.lat) * M_PER_DEG;
  return Math.hypot(dx, dy);
}

/** Perpendicular distance from `p` to the segment `a`–`b`, in metres. */
function perpM(p: LatLon, a: LatLon, b: LatLon): number {
  const ab = approxM(a, b);
  if (ab === 0) return approxM(p, a);
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * M_PER_DEG;
  const ax = a.lon * k;
  const ay = a.lat * M_PER_DEG;
  const bx = b.lon * k;
  const by = b.lat * M_PER_DEG;
  const px = p.lon * k;
  const py = p.lat * M_PER_DEG;
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / (ab * ab)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

/**
 * Douglas–Peucker, iterative rather than recursive so a 3,500-point track can't blow the
 * stack.
 *
 * DP and not the even-by-distance resampling the elevation profile uses, and the reason is
 * real: even sampling spends its budget uniformly, so it under-samples exactly the corners
 * that make a route recognisable and over-samples the straights. DP keeps the corners.
 */
function simplify(points: readonly LatLon[], toleranceM: number): LatLon[] {
  if (points.length < 3) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let worst = 0;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpM(points[i]!, points[lo]!, points[hi]!);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at !== -1 && worst > toleranceM) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * A track's points → the stored geometry, simplified until it fits the budget.
 *
 * The tolerance doubles until the point count is under the cap, bounded — a route that
 * refuses to simplify (every point a genuine corner) still terminates rather than looping.
 *
 * It STARTS TIGHT and loosens, rather than starting at a value that always fits. Measured
 * against the real Timberline export (3,522 points), 15 m produced 339 points — two-thirds
 * of the budget, with 31 m of worst-case deviation. There is no prize for coming in under
 * the cap: the budget exists to be spent on fidelity, and the loosening loop below is what
 * protects the bound. 6 m is finer than a consumer GPS fix, so the first pass costs nothing
 * a phone could have known.
 */
export function routeGeometryFromPoints(points: readonly LatLon[]): string | undefined {
  if (points.length < 2) return undefined;
  let tolerance = 6;
  let simplified = simplify(points, tolerance);
  for (let i = 0; i < 12 && simplified.length > MAX_ROUTE_POINTS; i++) {
    tolerance *= 2;
    simplified = simplify(points, tolerance);
  }
  if (simplified.length > MAX_ROUTE_POINTS) {
    // last resort: keep the ends and thin the middle evenly. Worse-looking than DP, but
    // bounded, and it only happens on a track this file was never designed for.
    const step = simplified.length / MAX_ROUTE_POINTS;
    const thinned: LatLon[] = [];
    for (let i = 0; i < MAX_ROUTE_POINTS; i++) thinned.push(simplified[Math.floor(i * step)]!);
    thinned[thinned.length - 1] = simplified[simplified.length - 1]!;
    simplified = thinned;
  }
  return normalizeRouteGeometry(encodePolyline(simplified));
}

/** Cumulative metres along the route at each point — the spine `alongM` is measured on. */
export function cumulativeM(points: readonly LatLon[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1]! + approxM(points[i - 1]!, points[i]!));
  return out;
}

/**
 * A distance along the route → the point there, interpolated between samples.
 *
 * This is what lets a waypoint store a single number instead of a coordinate: its position
 * is derived, so the only geography in the database is the route itself.
 */
export function pointAlong(points: readonly LatLon[], alongM: number): LatLon | null {
  if (points.length < 2) return points[0] ?? null;
  const cum = cumulativeM(points);
  const total = cum[cum.length - 1]!;
  if (!(total > 0)) return points[0]!;
  const target = Math.max(0, Math.min(total, alongM));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1]! < target) i++;
  const span = cum[i + 1]! - cum[i]!;
  const f = span > 0 ? (target - cum[i]!) / span : 0;
  const a = points[i]!;
  const b = points[i + 1]!;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

/**
 * The stretch of route between two distances, with both ends interpolated.
 *
 * The map draws one line per day, and the days have to MEET: cutting at the nearest stored
 * point instead would leave a gap of up to the sampling interval — around 125 m at the
 * simplification cap, which at whole-route zoom is a visible dropout in the middle of the
 * line. So both ends are exact points, and consecutive legs share their endpoint.
 *
 * Returns fewer than two points for an empty span, which the caller reads as "draw nothing"
 * — a day with no distance typed yet has no stretch to colour.
 */
export function sliceAlong(points: readonly LatLon[], fromM: number, toM: number): LatLon[] {
  if (points.length < 2 || !(toM > fromM)) return [];
  const cum = cumulativeM(points);
  const total = cum[cum.length - 1]!;
  const lo = Math.max(0, Math.min(total, fromM));
  const hi = Math.max(0, Math.min(total, toM));
  if (!(hi > lo)) return [];
  const head = pointAlong(points, lo);
  const tail = pointAlong(points, hi);
  if (!head || !tail) return [];
  // the stored points strictly inside the span; the ends are interpolated, not snapped
  const inner = points.filter((_, i) => cum[i]! > lo && cum[i]! < hi);
  return [head, ...inner, tail];
}

/** The nearest point ON the route to a coordinate, as a distance along it. Placement uses
 *  this so a pin can only ever sit on the line. */
export function nearestAlongM(points: readonly LatLon[], at: LatLon): number {
  if (points.length < 2) return 0;
  const cum = cumulativeM(points);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const d = perpM(at, a, b);
    if (d < bestD) {
      bestD = d;
      // project onto the segment for the along-distance, not just the segment start
      const segLen = approxM(a, b);
      const t = segLen > 0 ? Math.max(0, Math.min(1, approxM(a, at) / segLen)) : 0;
      best = cum[i]! + segLen * t;
    }
  }
  return Math.round(best);
}
