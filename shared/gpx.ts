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
 * `shares` are each stretch's distance; only their proportions matter, because the
 * profile is already sampled evenly by distance. The same smoothing and threshold the
 * whole-track figure uses, applied once across the profile and then attributed to
 * stretches — smoothing per stretch would treat every boundary as an edge and lose a
 * little climb at each one.
 */
export function segmentClimbs(
  profile: readonly number[],
  shares: readonly number[],
): { ascentM: number; descentM: number }[] {
  const total = shares.reduce((s, d) => s + d, 0);
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
  for (let i = 1; i < eased.length; i++) {
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
