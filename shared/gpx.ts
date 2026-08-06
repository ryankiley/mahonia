// GPX — reading a route file the browser already has.
//
// The file never leaves the device. There is no upload and no request: `File.text()` and
// `DOMParser`, both built in. That isn't only a privacy nicety — the site's CSP is
// `connect-src 'self'`, so sending it anywhere is not an option that exists, and the
// claim "your file stays in your browser" is therefore literally true rather than a
// promise. No XML dependency either; the bundle budget's whole argument forbids one.
//
// What this does NOT do is take over the route's numbers. It fills the distance and climb
// fields in for confirmation and the typed values stay the source of truth — a mangled
// track can't silently rewrite a route somebody entered by hand. Same conservatism
// trailLink.ts applies to names.

/** One point off the track. `ele` is often absent — plenty of tracks carry no elevation. */
export interface TrackPoint {
  lat: number;
  lon: number;
  ele?: number;
}

export interface GpxStats {
  distanceM: number;
  ascentM: number;
  descentM: number;
  minEleM: number;
  maxEleM: number;
  /** elevations sampled evenly BY DISTANCE — see resampleByDistance */
  profile: number[];
  pointCount: number;
}

/**
 * How many samples the stored profile keeps.
 *
 * Raised from 96: that was chosen to DRAW with, and it drew fine, but it flattened real
 * terrain — a 3,123 m loop measured only 1,608 m of climb off it, and hovering the chart
 * for a grade needs finer ground than a sample every 700 m. At 240 a 64 km route samples
 * every ~270 m, which is about where a hiker would say the gradient changed.
 *
 * The elevations stored here are RAW, never smoothed. Smoothing exists only inside the
 * ascent arithmetic, where summing noise is the failure; the drawn shape has no business
 * being tidied, and a smoothed profile would invent terrain between samples.
 */
export const PROFILE_SAMPLES = 240;

/**
 * Getting the ascent right is the whole difficulty of this file, and it takes TWO steps,
 * not one. This is the number people reach for first and it is not sufficient alone.
 *
 * Consumer GPS elevation is noisy to roughly ±5–10 m at 1 Hz. Summed naively, a FLAT
 * 20 km walk "climbs" several hundred metres of pure jitter — and that figure feeds
 * straight into the time and energy estimates, which are most sensitive to climb.
 *
 * A threshold alone does NOT fix it, which is the trap: noise of ±4 m produces 8 m
 * swings between consecutive points, so any threshold below 8 lets every one of them
 * through, and a threshold above 8 starts discarding real terrain. Raising it is a race
 * you lose in both directions.
 *
 * So the series is SMOOTHED first — a centred moving average, which cancels alternating
 * jitter while leaving a sustained climb almost untouched — and the threshold then only
 * has to reject what survives. Together they hold a flat noisy walk at zero and still
 * count a genuine climb in full; there are tests for both.
 *
 * CALIBRATED, not guessed. Swept against a real 64 km alpine loop (3,522 points, ~10,300
 * ft of published gain) the pairing below lands within 0.5%. For reference, from the same
 * track: an unfiltered sum reads +23%, and smoothing with a threshold of 10 reads −11%.
 *
 * A threshold of 8 with NO smoothing also matches that track exactly — and is rejected,
 * because that export's elevation is already clean. It would pass ±4 m of phone jitter
 * straight through, which is the case the filter exists for. The smoothing does the real
 * work; the threshold only sweeps up what survives.
 *
 * The result is a FILTERED ESTIMATE, not a measurement. Both numbers are choices. Say so
 * wherever the figure is shown.
 */
const ASCENT_THRESHOLD_M = 2;
const SMOOTH_WINDOW = 5;

/** Centred moving average, edge-clamped so the series keeps its length and its ends. */
function smooth(values: readonly number[], window: number): number[] {
  if (values.length < window) return [...values];
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      const v = values[Math.min(values.length - 1, Math.max(0, j))]!;
      sum += v;
      n++;
    }
    return sum / n;
  });
}

/** Refuse rather than block the main thread for seconds on a huge track. */
export const MAX_GPX_BYTES = 10_000_000;

const EARTH_R_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in metres. */
export function haversineM(a: TrackPoint, b: TrackPoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Track points out of a parsed GPX document, in file order.
 *
 * Both `trkpt` and `rtept`: a planned route is a `rte` and a recorded one is a `trk`, and
 * someone dropping a file in has no reason to care which they exported.
 */
export function gpxPoints(doc: Document): TrackPoint[] {
  // GPX first, then the other XML dialects that carry the same thing under other names.
  // A route is a route; which app exported it is not the walker's problem.
  const kml = kmlPoints(doc);
  if (kml.length) return kml;
  const tcx = tcxPoints(doc);
  if (tcx.length) return tcx;
  const nodes = doc.querySelectorAll("trkpt, rtept");
  const out: TrackPoint[] = [];
  for (const n of nodes) {
    const lat = Number(n.getAttribute("lat"));
    const lon = Number(n.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleText = n.querySelector("ele")?.textContent;
    const ele = eleText != null ? Number(eleText) : Number.NaN;
    out.push(Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon });
  }
  return out;
}

/**
 * KML / Google Earth. Coordinates arrive as whitespace-separated `lon,lat[,ele]` triples
 * inside `<coordinates>`, which is the one thing about this format worth knowing: the
 * order is LON FIRST, the opposite of every other format here and of how anybody says it.
 *
 * Every `<coordinates>` block is read and concatenated — a KML track is often split across
 * several `<LineString>`s, and stitching them is the same concession gpxPoints already
 * makes for multi-segment tracks.
 */
function kmlPoints(doc: Document): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const block of doc.querySelectorAll("coordinates")) {
    for (const triple of (block.textContent ?? "").trim().split(/\s+/)) {
      if (!triple) continue;
      const [lon, lat, ele] = triple.split(",").map(Number);
      if (!Number.isFinite(lat!) || !Number.isFinite(lon!)) continue;
      out.push(Number.isFinite(ele!) ? { lat: lat!, lon: lon!, ele: ele! } : { lat: lat!, lon: lon! });
    }
  }
  return out;
}

/**
 * TCX / Garmin Training Center. Lat and lon are child ELEMENTS rather than attributes, and
 * elevation is `<AltitudeMeters>` — the same data as a GPX trackpoint wearing longer names.
 */
function tcxPoints(doc: Document): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const n of doc.querySelectorAll("Trackpoint")) {
    const lat = Number(n.querySelector("LatitudeDegrees")?.textContent);
    const lon = Number(n.querySelector("LongitudeDegrees")?.textContent);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = Number(n.querySelector("AltitudeMeters")?.textContent);
    out.push(Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon });
  }
  return out;
}

/**
 * GeoJSON, which is JSON rather than XML and so never reaches a DOMParser.
 *
 * Reads LineString and MultiLineString, and the geometry inside a Feature or a
 * FeatureCollection — the four shapes a route is realistically exported as. Positions are
 * `[lon, lat, ele?]`, lon first again.
 *
 * Refuses rather than salvages, like everything else that takes a file here: a member that
 * isn't a pair of finite numbers is skipped, and a document with no recognisable geometry
 * yields nothing rather than a partial line.
 */
export function geoJsonPoints(raw: unknown): TrackPoint[] {
  const out: TrackPoint[] = [];
  const addLine = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    for (const pos of coords) {
      if (!Array.isArray(pos)) continue;
      const [lon, lat, ele] = pos as number[];
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push(typeof ele === "number" && Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon });
    }
  };
  const walk = (node: unknown, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    const n = node as Record<string, unknown>;
    if (n.type === "LineString") addLine(n.coordinates);
    else if (n.type === "MultiLineString" && Array.isArray(n.coordinates)) n.coordinates.forEach(addLine);
    if (n.geometry) walk(n.geometry, depth + 1);
    if (Array.isArray(n.features)) n.features.forEach((f) => walk(f, depth + 1));
    if (Array.isArray(n.geometries)) n.geometries.forEach((g) => walk(g, depth + 1));
  };
  walk(raw);
  return out;
}

/**
 * Resample elevations evenly along the DISTANCE walked, not along the point index.
 *
 * Point density is inversely proportional to speed — a recorder logging every second puts
 * far more points on a slow climb than on a fast descent. Sampling by index therefore
 * compresses the climbs and stretches the descents: it draws the wrong mountain.
 */
function resampleByDistance(
  cumulative: number[],
  elevations: number[],
  samples: number,
): number[] {
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (!(total > 0) || elevations.length < 2) return [];
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < samples; i++) {
    const target = (total * i) / (samples - 1);
    while (j < cumulative.length - 2 && cumulative[j + 1]! < target) j++;
    const d0 = cumulative[j]!;
    const d1 = cumulative[j + 1]!;
    const span = d1 - d0;
    const f = span > 0 ? (target - d0) / span : 0;
    out.push(Math.round(elevations[j]! + (elevations[j + 1]! - elevations[j]!) * f));
  }
  return out;
}

/**
 * Distance, climb and a profile from a track. Null when there isn't enough to say
 * anything — one point is a location, not a route.
 *
 * Distance is 2D. Slope-correcting it would inflate the figure against every trail sign
 * and every other tool, and on real terrain the difference is under 1%.
 */
export function gpxStats(points: readonly TrackPoint[]): GpxStats | null {
  if (points.length < 2) return null;

  const cumulative: number[] = [0];
  let distanceM = 0;
  for (let i = 1; i < points.length; i++) {
    distanceM += haversineM(points[i - 1]!, points[i]!);
    cumulative.push(distanceM);
  }
  if (!(distanceM > 0)) return null;

  const withEle = points.every((p) => p.ele != null)
    ? (points as TrackPoint[]).map((p) => p.ele!)
    : [];

  let ascentM = 0;
  let descentM = 0;
  let minEleM = 0;
  let maxEleM = 0;
  let profile: number[] = [];

  if (withEle.length) {
    minEleM = Math.min(...withEle);
    maxEleM = Math.max(...withEle);
    // Hysteresis: `reference` is the last elevation we committed a change from. A move is
    // only real once it clears the threshold, and then the reference jumps to it — so a
    // long steady climb still accumulates fully, while jitter around a level never does.
    const eased = smooth(withEle, SMOOTH_WINDOW);
    let reference = eased[0]!;
    for (const ele of eased) {
      const delta = ele - reference;
      if (delta >= ASCENT_THRESHOLD_M) {
        ascentM += delta;
        reference = ele;
      } else if (delta <= -ASCENT_THRESHOLD_M) {
        descentM += -delta;
        reference = ele;
      }
    }
    profile = resampleByDistance(cumulative, withEle, PROFILE_SAMPLES);
  }

  return {
    distanceM: Math.round(distanceM),
    ascentM: Math.round(ascentM),
    descentM: Math.round(descentM),
    minEleM: Math.round(minEleM),
    maxEleM: Math.round(maxEleM),
    profile,
    pointCount: points.length,
  };
}

/** The stored form: comma-joined integer metres, bounded. */
export function profileToString(profile: readonly number[]): string | undefined {
  if (!profile.length) return undefined;
  return profile.map((n) => Math.round(n)).join(",");
}

// 240 samples of up to 4 digits plus separators, with room to spare. Still nothing
// against a list's JSONB, and still a hard bound on what a hand-edited value can be.
const MAX_PROFILE_LEN = 2048;

/** A stored profile back into numbers, refusing anything that isn't one. */
export function parseProfile(raw: unknown): number[] {
  if (typeof raw !== "string" || !raw || raw.length > MAX_PROFILE_LEN) return [];
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part);
    // A profile is elevations in metres. Below the Dead Sea or above the troposphere it
    // isn't one, and rendering junk as terrain is worse than rendering nothing.
    if (!Number.isFinite(n) || n < -500 || n > 9000) return [];
    out.push(Math.round(n));
  }
  return out.length >= 2 ? out : [];
}


/**
 * Ascent and descent over each stretch of a stored profile, given how the ground is
 * divided up — so a day's climb can be READ OFF the route rather than typed.
 *
 * `shares` are each stretch's distance and `routeM` is how long the whole route is. BOTH
 * are needed, and the second is the one it is tempting to leave out: normalising the
 * shares against their OWN sum silently stretches a half-written itinerary across the
 * entire profile. Enter 10 miles of a 40-mile route on day 1 and day 1's stretch ends at
 * the last sample, so it is credited with every metre of climb on the route — a day's
 * climb that happens to equal the trip's, which reads plausible and is nonsense.
 *
 * Ground no day has claimed stays UNCLAIMED. Nothing past the last day's end is
 * attributed to anybody, which is the same thing the chart says by drawing that tail grey.
 *
 * The same smoothing and threshold the whole-track figure uses, applied once across the
 * profile and then attributed to stretches — smoothing per stretch would treat every
 * boundary as an edge and lose a little climb at each one.
 */
export function segmentClimbs(
  profile: readonly number[],
  shares: readonly number[],
  routeM?: number,
): { ascentM: number; descentM: number }[] {
  const stated = shares.reduce((s, d) => s + d, 0);
  const total = routeM != null && routeM > stated ? routeM : stated;
  if (profile.length < 2 || !shares.length || !(total > 0)) {
    return shares.map(() => ({ ascentM: 0, descentM: 0 }));
  }
  const eased = smooth(profile, SMOOTH_WINDOW);
  // the sample index each stretch ends at
  let run = 0;
  const ends = shares.map((d) => {
    run += d;
    return Math.round((run / total) * (eased.length - 1));
  });

  const out = shares.map(() => ({ ascentM: 0, descentM: 0 }));
  let seg = 0;
  let reference = eased[0]!;
  // Stop at the last day's end, not the profile's. Running on would sweep every unclaimed
  // metre past it into whichever stretch happened to be last.
  const lastEnd = ends[ends.length - 1] ?? eased.length - 1;
  for (let i = 1; i <= lastEnd; i++) {
    while (seg < ends.length - 1 && i > ends[seg]!) seg++;
    const delta = eased[i]! - reference;
    if (delta >= ASCENT_THRESHOLD_M) {
      out[seg]!.ascentM += delta;
      reference = eased[i]!;
    } else if (delta <= -ASCENT_THRESHOLD_M) {
      out[seg]!.descentM += -delta;
      reference = eased[i]!;
    }
  }
  return out.map((s) => ({ ascentM: Math.round(s.ascentM), descentM: Math.round(s.descentM) }));
}


/**
 * Each day's climb and drop, ready to show — segmentClimbs plus the magnitude correction,
 * in one place because TWO views need the identical number.
 *
 * SHAPE from the profile, MAGNITUDE from the full track. The stored profile is resampled,
 * which is plenty to draw with and too coarse to measure with: it smooths away some of the
 * real undulation, so proportions survive it and totals don't. `routeAscentM` is the climb
 * measured across the whole track, and the correction is scaled from the WHOLE profile —
 * not by forcing the days to sum to it, which would hand a part-written itinerary every
 * foot of the trip's ascent.
 *
 * Without a stored total (a profile from an older list) the shares stand as they are
 * rather than being invented.
 */
export function dayClimbs(
  profile: readonly number[],
  dayDistancesM: readonly number[],
  routeM: number | undefined,
  routeAscentM: number | undefined,
): { ascentM: number; descentM: number }[] {
  if (!profile.length) return [];
  const parts = segmentClimbs(profile, dayDistancesM, routeM || undefined);
  const wholeProfileClimb = segmentClimbs(profile, [1]).reduce((s, x) => s + x.ascentM, 0);
  if (!routeAscentM || !(wholeProfileClimb > 0)) return parts;
  const scale = routeAscentM / wholeProfileClimb;
  return parts.map((x) => ({
    ascentM: Math.round(x.ascentM * scale),
    descentM: Math.round(x.descentM * scale),
  }));
}


// ---- how hard the ground is ----

/**
 * Where a grade stops being a number and becomes a fact about the day.
 *
 * Published trail standards converge on these: moderate around 6–10%, hard above 10%
 * (Boulder's trail-grade standards, NPS Shenandoah, and the usual backpacking guides).
 * HARD is 10 deliberately — TrailProfile's hover readout already calls 10% steep, and one
 * definition beats two that drift apart.
 *
 * Those figures describe a trail's AVERAGE grade, though, and a profile samples the
 * instantaneous one, which is always steeper. That is why the series is smoothed first
 * (below) rather than banded raw: smoothing pulls a sample back toward the local average
 * the published numbers are actually about, and stops ±5–10 m of GPS noise painting a flat
 * walk as alternating red and grey confetti.
 */
export const GRADE_MODERATE_PCT = 6;
export const GRADE_HARD_PCT = 10;

/**
 * A WIDER window than the ascent arithmetic uses, and deliberately so.
 *
 * SMOOTH_WINDOW is tuned for one job: totalling climb to within half a percent of the
 * published figure. Banding wants something different — a stretch of trail long enough to
 * be worth calling steep. At 5 samples the real Timberline export bands into 51 runs over
 * 39.8 miles, one every three-quarters of a mile, which draws as a barcode rather than as
 * terrain and says nothing a walker could act on.
 *
 * 11 samples is ~2 km on a 40-mile route: about the length of a climb people talk about
 * ("the haul out of the canyon"), and much closer to the AVERAGE grade the published
 * difficulty bands are actually derived from.
 */
const GRADE_WINDOW = 11;

export type GradeBand = "easy" | "moderate" | "hard";

/** Direction-agnostic: a 15% descent is hard on the knees the way a 15% climb is on the lungs. */
function bandFor(gradePct: number): GradeBand {
  const g = Math.abs(gradePct);
  if (g >= GRADE_HARD_PCT) return "hard";
  if (g >= GRADE_MODERATE_PCT) return "moderate";
  return "easy";
}

/**
 * The profile cut into runs of like difficulty — `[from, to]` sample indices, inclusive,
 * each meeting the next so a renderer can draw them without a hairline of paper between.
 *
 * Lives here rather than in the component because it is arithmetic, it needs `smooth()`
 * (which is private to this file), and both the shading and anything else that wants to
 * say "how much of this route is steep" must agree on one answer.
 */
/**
 * The grade at every sample, as a percentage — ONE series, so everything that talks about
 * steepness is talking about the same numbers.
 *
 * This exists because the shading and the hover readout disagreed on screen: the readout
 * differenced the RAW profile and reported −19% at a point the shading had banded as easy,
 * because the shading was reading a smoothed series. Both were defensible and the pair was
 * incoherent. A reader pointing at a stretch and being told two different things about it
 * is worse than either answer being slightly off.
 *
 * Central difference over the smoothed series: steadier on noisy ground than looking one
 * sample ahead, and it doesn't lurch at the ends, where it falls back to the one neighbour
 * that exists.
 */
export function gradeSeries(profile: readonly number[], totalDistanceM: number): number[] {
  if (profile.length < 2 || !(totalDistanceM > 0)) return [];
  const runM = totalDistanceM / (profile.length - 1);
  if (!(runM > 0)) return [];
  const eased = smooth(profile, GRADE_WINDOW);
  return eased.map((_, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(eased.length - 1, i + 1);
    const run = runM * (hi - lo);
    return run > 0 ? ((eased[hi]! - eased[lo]!) / run) * 100 : 0;
  });
}

export function gradeRuns(
  profile: readonly number[],
  totalDistanceM: number,
): { from: number; to: number; band: GradeBand }[] {
  const grades = gradeSeries(profile, totalDistanceM);
  if (!grades.length) return [];
  // Banded on the ROUNDED grade, because that is the number a reader can see. The readout
  // prints "10%" for a true 9.6, and if the fill banded the raw value the label and the
  // ground beneath it would disagree at every threshold — the same incoherence one level
  // down from the one gradeSeries exists to fix.
  const bandAt = (i: number): GradeBand => bandFor(Math.round(grades[i]!));

  const out: { from: number; to: number; band: GradeBand }[] = [];
  let start = 0;
  let current = bandAt(0);
  for (let i = 1; i < profile.length; i++) {
    const b = bandAt(i);
    if (b === current) continue;
    out.push({ from: start, to: i, band: current }); // `to: i`, so runs share a sample
    start = i;
    current = b;
  }
  out.push({ from: start, to: profile.length - 1, band: current });
  return out;
}

/** How much of the route falls in each band, in metres — for the spoken description. */
export function gradeSpread(
  profile: readonly number[],
  totalDistanceM: number,
): Record<GradeBand, number> {
  const spread: Record<GradeBand, number> = { easy: 0, moderate: 0, hard: 0 };
  if (profile.length < 2) return spread;
  const per = totalDistanceM / (profile.length - 1);
  for (const r of gradeRuns(profile, totalDistanceM)) spread[r.band] += (r.to - r.from) * per;
  return spread;
}
