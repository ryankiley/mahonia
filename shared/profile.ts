// A route's SHAPE, once it is a list of numbers.
//
// Split out of gpx.ts, and the split is a bundle decision rather than a tidiness one.
// Reading a map file — XML dialects, a zip decoder, GeoJSON — is several hundred lines
// that only run when somebody picks a file, yet it sat on the first load of every packing
// list because the reducer imports parseProfile from the same module. So the two halves
// are now two files: this one is arithmetic on a stored profile, needed by the reducer and
// by every component that draws one; gpx.ts is the file reading, loaded on demand.
//
// The dependency runs one way ONLY — gpx.ts imports from here, never the reverse. A single
// import back the other way silently drags the whole parser onto the first load again,
// which is exactly the state this split exists to leave.

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
export const ASCENT_THRESHOLD_M = 2;
export const SMOOTH_WINDOW = 5;

/** Centred moving average, edge-clamped so the series keeps its length and its ends. */
export function smooth(values: readonly number[], window: number): number[] {
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
 * Ascent and descent over a whole series of elevations: the smoothing and the threshold
 * above, run end to end with nothing divided up.
 *
 * Shared with the file reader, which measures the same two numbers across a full track
 * rather than across a stored profile — it kept its own copy of this loop, which is two
 * places for the calibration above to be half-changed. The arithmetic is the same either
 * way; only the length of the series differs.
 */
export function totalClimb(elevations: readonly number[]): { ascentM: number; descentM: number } {
  return segmentClimbs(elevations, [1])[0] ?? { ascentM: 0, descentM: 0 };
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
  const wholeProfileClimb = totalClimb(profile).ascentM;
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

/**
 * Which band a grade falls in. Direction-agnostic: a 15% descent is hard on the knees the
 * way a 15% climb is on the lungs.
 *
 * Exported because the hover readout colours a single grade with it. That used to be a
 * second two-branch copy of the thresholds inside the chart, which is one edit away from a
 * tooltip that disagrees with the ground it is pointing at.
 */
export function gradeBandFor(gradePct: number): GradeBand {
  const g = Math.abs(gradePct);
  if (g >= GRADE_HARD_PCT) return "hard";
  if (g >= GRADE_MODERATE_PCT) return "moderate";
  return "easy";
}

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

/**
 * The profile cut into runs of like difficulty — `[from, to]` sample indices, inclusive,
 * each meeting the next so a renderer can draw them without a hairline of paper between.
 *
 * Lives here rather than in the component because it is arithmetic, it needs `smooth()`
 * (which is private to this file), and both the shading and anything else that wants to
 * say "how much of this route is steep" must agree on one answer.
 */
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
  const bandAt = (i: number): GradeBand => gradeBandFor(Math.round(grades[i]!));

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
