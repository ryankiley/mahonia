// What a day FEELS like, read off the route's stored profile.
//
// Distance, climb and descent are the right inputs for a day and they do not say what the
// day is like: 900 m of climb spread over 20 km is a long gentle morning, and the same 900
// m in 3 km is the haul everyone remembers. The profile knows the difference, and so does
// the elevation at the day's end, which is where you sleep. A per-day terrain INPUT was
// considered and rejected (issue #320): nobody can honestly rate a whole day "rough", and
// a guessed number is the kind of input this app avoids. Everything here is derived,
// marked derived where it is shown, and silent on a day with no distance.
//
// Its own file rather than more of profile.ts on purpose: profile.ts rides the first load
// (the reducer parses a stored profile), and this is read by the Trip tab alone.

import { ASCENT_THRESHOLD_M, SMOOTH_WINDOW, gradeSeries, smooth, totalClimb } from "./profile";
import type { DayRange } from "./tripPlan";

/** A sustained climb: where it starts along the route, how far it runs, what it gains. */
export interface Climb {
  startM: number;
  lengthM: number;
  gainM: number;
}

export interface DayFacts {
  /** the elevation at the day's end, where you sleep (or where the walk ends) */
  campM: number;
  /** the day's high and low points */
  highM: number;
  lowM: number;
  /** the camp's height over the trailhead, signed */
  aboveTrailheadM: number;
  /** the longest sustained climb by gain, when the day has one worth naming */
  climb?: Climb;
  /** the steepest stretch, signed (a descent reads negative), and where it is */
  steepest?: { gradePct: number; atM: number };
}

/**
 * How much cooler the air is at a height, as a rule of thumb: the environmental lapse
 * rate, 6.5 °C per kilometre of altitude. The standard atmosphere's figure and the
 * middle of what real days do (a dry sunny afternoon runs near 10, a cloudy night near
 * 4). Stated as "about", never as a forecast; it is the one thing about conditions the
 * list can say with no network at all (issue #344, its first layer).
 */
export const LAPSE_C_PER_KM = 6.5;
export const coolerByC = (aboveM: number): number => (aboveM / 1000) * LAPSE_C_PER_KM;

/** a climb shorter than this is a bump, not a climb worth naming */
const MIN_CLIMB_GAIN_M = 30;

/** the elevation `alongM` into a profile that spans `routeM`, interpolated */
function elevationAt(profile: readonly number[], routeM: number, alongM: number): number {
  const n = profile.length;
  const pos = (Math.max(0, Math.min(routeM, alongM)) / routeM) * (n - 1);
  const i = Math.min(n - 2, Math.floor(pos));
  const f = pos - i;
  return profile[i]! + (profile[i + 1]! - profile[i]!) * f;
}

/**
 * The facts for one day. Null when there is nothing to read: no profile, no route
 * length, or a day that owns no ground.
 *
 * Heights come off the RAW profile (a camp is where the samples say it is; smoothing
 * would move a summit). The climb and the grade come off the SMOOTHED series, the same
 * one the day's climb total and the chart's shading use, so a day's "longest climb"
 * can't claim a gain its own climb figure doesn't. The gain is scaled by the route's
 * full-resolution ascent the way dayClimbs scales, since the stored profile smooths
 * away some real undulation and under-reads a climb by the same share.
 */
export function dayFacts(
  profile: readonly number[],
  routeM: number | undefined,
  range: DayRange,
  routeAscentM?: number,
): DayFacts | null {
  if (profile.length < 2 || !routeM || !(routeM > 0) || !(range.toM > range.fromM)) return null;
  const n = profile.length;
  const stepM = routeM / (n - 1);
  const fromM = Math.max(0, range.fromM);
  const toM = Math.min(routeM, range.toM);
  if (!(toM > fromM)) return null;
  const first = Math.ceil(fromM / stepM);
  const last = Math.floor(toM / stepM);

  const campM = elevationAt(profile, routeM, toM);
  let highM = Math.max(elevationAt(profile, routeM, fromM), campM);
  let lowM = Math.min(elevationAt(profile, routeM, fromM), campM);
  for (let i = first; i <= last; i++) {
    const e = profile[i]!;
    if (e > highM) highM = e;
    if (e < lowM) lowM = e;
  }

  const out: DayFacts = {
    campM,
    highM,
    lowM,
    aboveTrailheadM: campM - profile[0]!,
  };

  // the longest climb: the smoothed series walked with the ascent hysteresis, a run
  // extending while the ground keeps rising past the threshold and ending when it
  // drops by as much
  if (last > first) {
    const eased = smooth(profile, SMOOTH_WINDOW);
    const wholeProfileClimb = totalClimb(profile).ascentM;
    const scale = routeAscentM && wholeProfileClimb > 0 ? routeAscentM / wholeProfileClimb : 1;
    let best: Climb | undefined;
    let runStart = first;
    let runLow = eased[first]!;
    let runHigh = eased[first]!;
    let highAt = first;
    const close = () => {
      const gain = (runHigh - runLow) * scale;
      if (gain < MIN_CLIMB_GAIN_M || (best && gain <= best.gainM)) return;
      // Where the climb STARTS and TOPS OUT is read off the series against the threshold,
      // not off where the run happened to open and peak. runStart is wherever the ground
      // last touched a new low, and on a flat approach with any noise at all that is the
      // deepest wobble: kilometres before the climb on a jittery track, at the trailhead
      // under the ±4 m the ascent filter is calibrated against. The foot is the last
      // sample still within the threshold of the run's low, which is where the ground
      // stops being flat; the top is its mirror, the first sample within the threshold of
      // the high, rather than the highest wobble somewhere along a summit plateau.
      let foot = runStart;
      for (let j = runStart; j <= highAt; j++) if (eased[j]! <= runLow + ASCENT_THRESHOLD_M) foot = j;
      let top = highAt;
      for (let j = foot; j <= highAt; j++) {
        if (eased[j]! >= runHigh - ASCENT_THRESHOLD_M) { top = j; break; }
      }
      best = { startM: foot * stepM, lengthM: (top - foot) * stepM, gainM: Math.round(gain) };
    };
    for (let i = first + 1; i <= last; i++) {
      const e = eased[i]!;
      if (e > runHigh) {
        runHigh = e;
        highAt = i;
      } else if (runHigh - e >= ASCENT_THRESHOLD_M) {
        // the climb is over: bank it and start looking for the next from here
        close();
        runStart = i;
        runLow = e;
        runHigh = e;
        highAt = i;
      }
      if (e <= runLow && runHigh - runLow < ASCENT_THRESHOLD_M) {
        // still on the way down to, or along the flat before, the foot of the next
        // climb: the climb starts where the ground last stopped falling
        runStart = i;
        runLow = e;
        runHigh = e;
        highAt = i;
      }
    }
    close();
    if (best) out.climb = best;

    // the steepest stretch, off the one grade series the chart shades by
    const grades = gradeSeries(profile, routeM);
    let steepest: { gradePct: number; atM: number } | undefined;
    for (let i = first; i <= last; i++) {
      const g = grades[i]!;
      if (!steepest || Math.abs(g) > Math.abs(steepest.gradePct)) steepest = { gradePct: g, atM: i * stepM };
    }
    if (steepest && Math.abs(steepest.gradePct) >= 1) out.steepest = { gradePct: Math.round(steepest.gradePct), atM: steepest.atM };
  }
  return out;
}
