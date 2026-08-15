// Food adequacy — "is there enough food in here?", answered with division.
//
// The list already knows two things it never puts together: the calories on its
// consumable rows (Totals.kcalTotal) and the dates of the trip. Calories alone are a
// number with no scale — 9,000 kcal is a feast for a weekend and starvation for a
// week. Per DAY, the same number reads instantly. That's the whole feature.
//
// WHAT THIS FILE DOESN'T DO — and where it went instead.
//
// This used to say a burn model wasn't here, because one needs body weight, pace and
// gradient and the app had none of the three. It has all three now: the planning view
// asks for body weight, the route's profile supplies the gradient, and pace is derived
// from that gradient rather than assumed. The model lives in shared/tripPlan.ts.
//
// The reasoning that kept it out is still the reasoning that governs it: the figures are
// marked as estimates wherever they appear, the body weight is stated in the tooltip so a
// reader knows what it was computed against, and the default is labelled as assumed
// rather than presented as known. A confident wrong number is still worse than an honest
// ratio — the same rule trailLink.ts follows when it declines to invent a name.
//
// What stays here is the ratio: arithmetic on numbers the owner actually entered, with
// the comparison band named as a rule of thumb and nothing more.

import type { ListMeta, Totals } from "./types";
import { formatDistance, resolveDistanceUnit } from "./trailDistance";

/** How a day's calorie figure reads against the planning band. */
export type FoodReading = "light" | "typical" | "generous";

// A common planning range for days spent walking with a pack, not a nutritional
// recommendation for a person — bodies, terrain and effort all move it, which is why
// the UI says "a common range" and never "you need". The band is wide on purpose:
// its job is to catch the list with a day of food for a five-day trip, not to
// second-guess someone who knows what they eat.
export const KCAL_PER_DAY_LIGHT = 2500;
export const KCAL_PER_DAY_GENEROUS = 4500;

/**
 * Calendar days a trip covers, INCLUSIVE of both ends — 4th to 6th is three days,
 * which is how many days you eat on. Null unless both dates are present and the end
 * doesn't precede the start.
 *
 * Parsed as UTC instants purely to subtract them. The stored values are calendar
 * dates with no timezone (see ListMeta.startDate), and anchoring both at T00:00:00Z
 * keeps the subtraction on the same footing they were written on — a local-midnight
 * Date would put the two ends in different offsets across a DST boundary and lose or
 * gain a day.
 */
export function tripDays(
  startDate: string | undefined,
  endDate: string | undefined,
): number | null {
  if (!startDate || !endDate) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

/** What the food line renders, or null when the list hasn't earned one. */
export interface FoodPlan {
  /** inclusive calendar days the dates cover */
  days: number;
  /** kcalTotal spread across those days, rounded — the headline */
  kcalPerDay: number;
  /** how that reads against the band above */
  reading: FoodReading;
  /** route length ÷ days, already formatted, when a distance is set. Not part of the
   *  calorie question — it's the other thing dividing by days makes obvious. */
  perDayDistance: string | null;
}

/**
 * The list's food figures, or null when there's nothing honest to say — no calories
 * entered, or no date range to divide by. Both gates matter: kcal with no dates is
 * the number the user already sees in the totals bar, and dates with no kcal is a
 * trip nobody logged food for.
 */
export function foodPlan(
  totals: Pick<Totals, "kcalTotal" | "hasKcal">,
  meta: Pick<ListMeta, "startDate" | "endDate" | "trailDistanceM" | "trailDistanceUnit">,
): FoodPlan | null {
  if (!totals.hasKcal || totals.kcalTotal <= 0) return null;
  const days = tripDays(meta.startDate, meta.endDate);
  if (!days) return null;

  const kcalPerDay = Math.round(totals.kcalTotal / days);
  const reading: FoodReading =
    kcalPerDay < KCAL_PER_DAY_LIGHT
      ? "light"
      : kcalPerDay > KCAL_PER_DAY_GENEROUS
        ? "generous"
        : "typical";

  const distance = meta.trailDistanceM;
  const perDayDistance = distance
    ? formatDistance(Math.round(distance / days), resolveDistanceUnit(meta.trailDistanceUnit))
    : null;

  return { days, kcalPerDay, reading, perDayDistance };
}
