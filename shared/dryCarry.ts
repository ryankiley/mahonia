// The longest dry carry: how far you walk between one water and the next.
//
// The number a walker plans around on a dry section, and the one thing the water pins
// were not yet used for. A pin is stored as a distance along the route, a day is a range
// of that route, and the walking-time model gives hours per day; this file is the
// arithmetic between them, pure and on its own, in the style of shared/tripPlan.ts.
//
// The sources of water are the pins marked water plus the two ends of the route: you
// leave the trailhead with what you carried in, and the finish is where carrying stops.
// A carry is the stretch between two consecutive sources. It is measured IN FULL even
// when it crosses a day boundary: a camp is not a spring, and the litres you shoulder at
// the last water have to last until the next one, whatever day that falls on. A day's
// figure is therefore the longest carry that touches the day, not the longest stretch
// inside it, which could hide the long carry that straddles the night.
//
// With no water pins at all, the whole route is one carry, and that is not a finding.
// dryCarries returns nothing then, so a day says "add a water pin" rather than showing
// the route's length as though it were a carry.

import type { DayRange } from "./tripPlan";

export interface WaterSource {
  alongM: number;
  /** the pin's own name, when it has one; the ends carry none */
  label?: string;
  kind: "trailhead" | "water" | "finish";
}

/** One stretch between two consecutive sources. */
export interface DryCarry {
  fromM: number;
  toM: number;
  from: WaterSource;
  to: WaterSource;
}

/** two pins closer than this are one source; the ends are seeded by arithmetic
 *  (a route's length, a day's cumulative end) and a hand-placed pin at "the trailhead"
 *  can sit a few metres off it */
const SAME_SOURCE_M = 5;

/**
 * Every carry on the route, in route order.
 *
 * `waterPins` are the water pins as stored (a distance and maybe a label); `routeM` is
 * the route's length, which is where the finish is. Pins off the route (past its end,
 * or negative) are ignored rather than clamped: a pin past the finish is a data error,
 * not a source a metre from the end.
 */
export function dryCarries(waterPins: readonly { alongM: number; label?: string }[], routeM: number): DryCarry[] {
  if (!(routeM > 0)) return [];
  const water = waterPins
    .filter((p) => Number.isFinite(p.alongM) && p.alongM >= 0 && p.alongM <= routeM)
    .map((p): WaterSource => ({ alongM: p.alongM, label: p.label?.trim() || undefined, kind: "water" }))
    .sort((a, b) => a.alongM - b.alongM);
  if (!water.length) return [];
  const sources: WaterSource[] = [{ alongM: 0, kind: "trailhead" }];
  for (const w of water) {
    const last = sources[sources.length - 1]!;
    if (w.alongM - last.alongM < SAME_SOURCE_M) {
      // the same place twice: the first position stands, and it takes the name if
      // only the second has one, since a name is what a reader finds on the map
      if (!last.label && w.label && last.kind === "water") last.label = w.label;
      continue;
    }
    sources.push(w);
  }
  const finish: WaterSource = { alongM: routeM, kind: "finish" };
  const lastSource = sources[sources.length - 1]!;
  if (routeM - lastSource.alongM >= SAME_SOURCE_M) sources.push(finish);
  const carries: DryCarry[] = [];
  for (let i = 1; i < sources.length; i++) {
    const from = sources[i - 1]!;
    const to = sources[i]!;
    carries.push({ fromM: from.alongM, toM: to.alongM, from, to });
  }
  return carries;
}

/**
 * The longest carry a day walks any part of, measured in full. Null for a day that owns
 * no ground (a zero-width range) or when there are no carries.
 */
export function longestCarryForDay(carries: readonly DryCarry[], range: DayRange): DryCarry | null {
  if (!(range.toM > range.fromM)) return null;
  let best: DryCarry | null = null;
  for (const c of carries) {
    // half-open on both sides, like the day grouping: a carry that ENDS exactly where
    // the day starts was walked yesterday, and one that starts where the day ends is
    // tomorrow's
    if (c.toM <= range.fromM || c.fromM >= range.toM) continue;
    if (!best || c.toM - c.fromM > best.toM - best.fromM) best = c;
  }
  return best;
}

/**
 * Hours for a carry, from the days it crosses: each day's estimate scaled by the share
 * of that day the carry covers, summed. Undefined when any part of the carry falls on
 * ground with no estimate (a day with no distance, or the unassigned tail past the
 * last day), because a number for half a carry reads as a number for the carry.
 */
export function carryHours(
  carry: Pick<DryCarry, "fromM" | "toM">,
  ranges: readonly DayRange[],
  dayHours: readonly (number | undefined)[],
): number | undefined {
  const length = carry.toM - carry.fromM;
  if (!(length > 0)) return undefined;
  let covered = 0;
  let hours = 0;
  ranges.forEach((r, i) => {
    const dayLength = r.toM - r.fromM;
    if (!(dayLength > 0)) return;
    const overlap = Math.min(carry.toM, r.toM) - Math.max(carry.fromM, r.fromM);
    if (!(overlap > 0)) return;
    const h = dayHours[i];
    if (h == null) return;
    covered += overlap;
    hours += (h * overlap) / dayLength;
  });
  // within a metre of the whole, since the ranges and the carry arrive by different sums
  return length - covered <= 1 ? hours : undefined;
}
