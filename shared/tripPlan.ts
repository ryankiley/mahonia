// Trip modelling — how long a day on the trail takes, and what it costs to walk it.
//
// Pure arithmetic over SI inputs. No Vue, no list types, no I/O: this module knows
// about distances, slopes and kilograms, and nothing about Mahonia. That's deliberate —
// it means the maths can be reviewed, and tested, entirely on its own terms.
//
// ── WHY THESE EQUATIONS AND NOT THE FAMOUS ONES ────────────────────────────────
//
// The obvious picks are Pandolf (1977) for energy and Naismith (1892) for time. Nearly
// every hiking calculator uses them. Both were rejected here on evidence:
//
// ENERGY. Ludlow & Weyand's "minimum mechanics" model (J Appl Physiol 2017) beats
// Pandolf badly when the two are checked against *measured outdoor oxygen consumption*
// rather than a treadmill (J Appl Physiol 2021, same subjects, same inputs):
//
//     minimum mechanics   +4% unloaded   −2% loaded
//     ACSM               +13%
//     Pandolf/Santee     +17%           +12%
//     Looney (2019)      +20%
//
// So it is 4–6× more accurate, and it is also the simpler equation. The usual reason to
// reach for Pandolf — that it accounts for a carried load — applies here too; those are
// the only two that model load at all. Between-equation spread on identical inputs runs
// to 37%, which makes this choice worth more than any amount of tuning inside a choice.
//
// Pandolf has a second problem that is disqualifying for hiking specifically: it models
// level and uphill only. Applied to a descent it overestimates by 20–30% and can return
// a metabolic rate BELOW RESTING — Pandolf's own group said so later. Santee's 2001
// correction patches that to about −12% grade and overcorrects past it. Every
// out-and-back is half descent, so this is not an edge case.
//
// TIME. Naismith with the Langmuir descent correction implies a maximum speed of about
// 12 km/h at −12°, which is faster than a human can walk (~9 km/h), and it arrives there
// through hard thresholds at 5° and 12°. Tobler's hiking function is one smooth curve,
// physically sane at every slope, and better on rugged ground. Both land near ±20%.
//
// ── ON THE COEFFICIENTS ────────────────────────────────────────────────────────
//
// The minimum-mechanics paper is paywalled; the coefficients below come from a table
// reproduced in the (open) 2021 field study. That reproduction is ambiguous in two ways,
// and BOTH were resolved by physical validation rather than by trusting the transcript —
// the tests pin the outcome so a future edit can't silently undo it:
//
//   1. It prints `(w+l)wt(…)`. VO2 is per-kilogram, so the load term has to be the RATIO
//      (w+l)/w; the product form yields values an order of magnitude too large.
//   2. It says grade is "expressed as decimal". It is not — it is PERCENT. As a decimal
//      the grade term all but vanishes and walking uphill comes out CHEAPER than walking
//      on the flat. In percent the model tracks the independent ACSM equation closely
//      across the whole validated range, and sits below it by about the margin the field
//      study measured between the two.
//
// Validated range (from the paper): 0.4–1.6 m/s, −6° to +9°, loads to +31% body weight.
// Outside that we are extrapolating, which is the caller's problem to disclose.

/**
 * Terrain multipliers on the energy cost. Only the first two are from the source
 * (asphalt 1.0, grass 1.08, measured at 1.3–1.6 m/s); the rougher ones are the
 * conventional load-carriage figures and are cited as such rather than as measured.
 */
const TERRAIN_FACTORS = {
  paved: 1.0,
  trail: 1.08,
  rough: 1.2,
} as const;
export type Terrain = keyof typeof TERRAIN_FACTORS;

// Tobler's hiking function: v = 6·exp(−3.5·|slope + 0.05|) km/h, slope as rise/run.
// 5 km/h on the flat, peaking at 6 km/h on a gentle −5% grade — the small downhill that
// really is faster than level ground, which is the detail Naismith gets wrong.
const TOBLER_MAX_KMH = 6;
const TOBLER_DECAY = 3.5;
const TOBLER_PEAK_SLOPE = 0.05;

/**
 * Walking speed on a given slope, in m/s. `slope` is rise/run and SIGNED: 0.1 is a 10%
 * climb, −0.1 a 10% descent.
 *
 * `loadKg` — the pack carried through the day (its midpoint weight, see burnDownMg) —
 * applies Naismith's pack penalty — 1% slower per kilogram carried. Tobler's
 * function has no load term of its own, so this rides on top as a separate, honest
 * multiplier rather than being smuggled into the curve.
 */
/** See toblerSpeedMs: a floor that keeps an absurd gradient finite rather than Infinite. */
const MIN_SPEED_MS = 0.01;

export function toblerSpeedMs(slope: number, loadKg = 0): number {
  const kmh = TOBLER_MAX_KMH * Math.exp(-TOBLER_DECAY * Math.abs(slope + TOBLER_PEAK_SLOPE));
  const penalty = 1 + 0.01 * Math.max(0, loadKg);
  // Floored, because the exponential underflows to exactly 0 on absurd input and the
  // callers divide by this: a day claiming 106 m of climb per metre walked produced an
  // Infinite duration and then a NaN calorie figure (0 × Infinity), which spread to the
  // trip totals and put "NaN" on screen. Nothing upstream rejects that day — distance and
  // climb are validated separately and never against each other — so the floor lives
  // here. 0.01 m/s is 36 m an hour: still nonsense, but nonsense that stays a number.
  return Math.max(MIN_SPEED_MS, (kmh / 3.6) / penalty);
}

/**
 * Rate of oxygen uptake while walking, mL/kg/min — the minimum-mechanics model.
 *
 * `gradePct` is SIGNED percent (10 = a 10% climb, −10 = a 10% descent). The sign matters
 * enormously: the model branches on it, and the two branches are shaped differently.
 *
 * Note what the descent branch does NOT have: a grade term. Below level it is a flat 0.73
 * multiplier on the level cost, so every descent costs the same whatever its steepness.
 * That is the model as published, and it was only validated to −6°.
 *
 * WHICH WAY THAT ERRS DEPENDS ON THE GRADE, and this comment used to get it backwards. It
 * said the flat multiplier understates a steep descent. It does — past about −25°, where
 * braking really is hard work. But between roughly −5% and −20%, which is nearly every
 * descent anyone walks, it OVERSTATES: Minetti's measured cost of walking puts the
 * descent-to-level ratio near 0.4–0.6 through that band, against this 0.73. On a
 * descent-heavy day that is worth something like a tenth of the walking energy.
 *
 * Left as published rather than patched. Replacing 0.73 with a grade-dependent curve means
 * blending two models, and this file's whole posture is to ship a published equation with
 * its limits written down rather than a hybrid we invented. The limit is now written down
 * in the direction it actually points.
 */
export function walkingVo2(opts: {
  speedMs: number;
  gradePct: number;
  bodyKg: number;
  loadKg?: number;
  terrain?: Terrain;
}): number {
  const { speedMs, gradePct, bodyKg } = opts;
  const loadKg = Math.max(0, opts.loadKg ?? 0);
  const wt = TERRAIN_FACTORS[opts.terrain ?? "trail"];
  if (!(bodyKg > 0) || !(speedMs > 0)) return 0;

  const gravitational = (bodyKg + loadKg) / bodyKg;
  const s2 = speedMs * speedMs;

  if (gradePct >= 0) {
    return 3.05 + gravitational * wt * (0.32 * gradePct + 3.28 + (1 + 0.19 * gradePct) * 2.66 * s2);
  }
  return 3.05 + 0.73 * gravitational * wt * (3.28 + 2.66 * s2);
}

// A litre of oxygen releases this much, burning the mix a walking body actually burns —
// the step the model itself doesn't take, since it stops at oxygen.
//
// 4.83, not 5. Five is the round number for carbohydrate alone, and implies a respiratory
// exchange ratio near 0.96 — sprinting, not walking. The source paper picks 20.1 J/mL for
// exactly this activity and then measures RER 0.83 in its own subjects, which is 20.2 J/mL
// = 4.83 kcal/L. The round number was a flat 4% on every walking calorie.
const KCAL_PER_L_O2 = 4.83;

/** Walking energy for one stretch, in kcal. Mass is what turns mL/kg/min into mL/min. */
export function walkingKcal(
  opts: Parameters<typeof walkingVo2>[0] & { hours: number },
): number {
  const vo2 = walkingVo2(opts);
  const litresPerMin = (vo2 * opts.bodyKg) / 1000;
  return litresPerMin * KCAL_PER_L_O2 * 60 * Math.max(0, opts.hours);
}

/**
/**
 * Basal rate, kcal per hour, from body mass alone.
 *
 * SCHOFIELD'S WEIGHT-ONLY FORM, and the intercept is the entire point. This used to be a
 * flat 1 kcal per kg per hour, which is not a rule of thumb — it is the definition of one
 * MET, derived from a single 70 kg man. Metabolic rate does not scale linearly with mass;
 * it goes roughly as M^0.75, so the marginal kilogram costs about 10 kcal a day, not the
 * 24 a per-kg rule bills for it.
 *
 * The error is therefore a function of the walker. Against Mifflin-St Jeor the old rule
 * was about right at 70 kg and 26% high at 102 kg — so the app quietly over-fed heavier
 * people and nobody could see it, because the figure looked the same shape either way.
 * This form is within a few per cent across the range: 0.93 kcal/kg/hr at 70 kg, 0.77 at
 * 102 kg.
 *
 * Still weight-only, which is the property the old comment was right to protect:
 * Mifflin-St Jeor needs age, sex and height, and this app has none of the three and
 * shouldn't ask. Schofield's sex-neutral 30–60 band needs exactly what we already have.
 */
const SCHOFIELD_PER_KG = 10.15;
const SCHOFIELD_INTERCEPT = 854;
function basalKcalPerHour(bodyKg: number): number {
  return (SCHOFIELD_PER_KG * bodyKg + SCHOFIELD_INTERCEPT) / 24;
}

/**
 * How much above basal each kind of non-walking hour costs.
 *
 * SLEEP IS NOT CAMP. The old code billed one undifferentiated block at 1.4 — a whole day
 * of it, sleep included — which charged eight hours of lying still at the rate of pitching
 * a tent. FAO/WHO/UNU put sleep at 1.0; measured overnight rate runs a few per cent BELOW
 * basal, so 1.0 is already generous.
 *
 * And 1.4 was the wrong number even for the waking hours: FAO's 1.40 is a WHOLE-DAY
 * sedentary PAL, walking and all. Applied to hours the walk has already been removed from
 * and billed separately, it counted part of the effort twice. 1.5 is the awake-and-pottering
 * figure, which is what making camp actually is.
 */
const SLEEP_PAR = 1.0;
const CAMP_PAR = 1.5;
/** A night, in hours. Not asked for — nobody wants a sleep field in a packing app. */
const SLEEP_HOURS = 8;

/**
 * Resting energy for the hours NOT spent walking, in kcal.
 *
 * Split into sleep and camp, because they are not the same hour and billing them at one
 * rate was worth several hundred calories a day on its own.
 *
 * The whole term dominates the estimate — on a 3½ hour day it is roughly twice the walking
 * energy — which is why the two corrections here move the day's figure far more than
 * anything in the walking model does.
 */
export function restingKcal(bodyKg: number, hours: number): number {
  if (!(bodyKg > 0)) return 0;
  const total = Math.max(0, Math.min(24, hours));
  const asleep = Math.min(SLEEP_HOURS, total);
  const awake = total - asleep;
  return basalKcalPerHour(bodyKg) * (asleep * SLEEP_PAR + awake * CAMP_PAR);
}

/** One leg of a day: a distance walked at a single signed slope. */
export interface Leg {
  distanceM: number;
  slope: number;
}

/**
 * Split a day into an up leg and a down leg.
 *
 * A day is given to us as a distance and a climb — and a climb alone is not a grade.
 * `ascent / distance` is always positive, which would model the whole day as uniformly
 * uphill; a 16 km day with 800 m of climb is really about 10% up for 8 km and 10% DOWN
 * for 8 km, and those cost very differently precisely because the equations branch on
 * the sign.
 *
 * `descentM` defaults to the ascent, which is exactly right for an out-and-back or a
 * loop — most trips — and is the assumption a caller must disclose. Pass it explicitly
 * for a point-to-point that ends lower or higher than it started.
 */
export function dayLegs(distanceM: number, ascentM: number, descentM = ascentM): Leg[] {
  if (!(distanceM > 0)) return [];
  const up = Math.max(0, ascentM);
  const down = Math.max(0, descentM);
  if (up + down === 0) return [{ distanceM, slope: 0 }];

  // Distance is split in proportion to the climbing each leg does, so a day that climbs
  // 900 m and drops 100 m spends most of its ground going up — which is what makes it a
  // hard day, and what a half-and-half split would hide.
  const upShare = up / (up + down);
  const upDist = distanceM * upShare;
  const downDist = distanceM - upDist;

  const legs: Leg[] = [];
  if (upDist > 0) legs.push({ distanceM: upDist, slope: up / upDist });
  if (downDist > 0) legs.push({ distanceM: downDist, slope: -down / downDist });
  return legs;
}

/** What a single day asks of you. */
export interface DayEstimate {
  hours: number;
  walkingKcal: number;
  restingKcal: number;
  /** walking + resting, the whole day */
  totalKcal: number;
}

/**
 * Estimate one day. `loadKg` is the pack at the MIDDLE of the day (see burnDownMg) — the
 * caller works that out from the burn-down, because only it knows what has been eaten.
 * The start-of-day figure is the over-read burnDownMg's midpoint exists to avoid.
 *
 * Returns null when there's nothing to estimate. A day with no distance is not a
 * zero-calorie day; it's a day nobody described, and saying "0" about it would be a
 * claim. Same rule the rest of the app follows: decline rather than invent.
 */
export function estimateDay(opts: {
  distanceM: number;
  ascentM: number;
  descentM?: number;
  bodyKg: number;
  loadKg?: number;
  terrain?: Terrain;
}): DayEstimate | null {
  const legs = dayLegs(opts.distanceM, opts.ascentM, opts.descentM);
  if (!legs.length || !(opts.bodyKg > 0)) return null;

  const loadKg = Math.max(0, opts.loadKg ?? 0);
  let hours = 0;
  let walking = 0;
  for (const leg of legs) {
    const speedMs = toblerSpeedMs(leg.slope, loadKg);
    const legHours = leg.distanceM / speedMs / 3600;
    hours += legHours;
    walking += walkingKcal({
      speedMs,
      gradePct: leg.slope * 100,
      bodyKg: opts.bodyKg,
      loadKg,
      terrain: opts.terrain,
      hours: legHours,
    });
  }

  const resting = restingKcal(opts.bodyKg, 24 - hours);
  return {
    hours,
    walkingKcal: walking,
    restingKcal: resting,
    totalKcal: walking + resting,
  };
}

/**
 * The pack's weight at the MIDDLE of each of `days` days, in milligrams.
 *
 * The midpoint, not the trailhead figure — see the note on the loop below. A day is spent
 * getting from one to the next, so the weight it is actually walked under is the average
 * of its ends, and the start-of-day figure over-reads every day's effort.
 *
 * The pack is heaviest at the trailhead and lightest at the end, because you eat it. This
 * is the figure a static "pack weight" gets wrong, and the one the app is unusually well
 * placed to get right — it already knows carried and consumable weight separately.
 *
 * `burnableMg` must EXCLUDE water. Water refills; it doesn't depend down. Counting it as
 * eaten makes the late days weightlessly cheap. (The caller does that subtraction because
 * the water test lives on item names, which this module deliberately knows nothing about.)
 */
export function burnDownMg(carriedMg: number, burnableMg: number, days: number): number[] {
  if (!(days > 0)) return [];
  const burnable = Math.max(0, Math.min(burnableMg, carriedMg));
  const perDay = burnable / days;
  // The MIDPOINT of each day, not its start: day 1 shouldn't be modelled carrying food
  // it has already eaten by lunchtime, and the last day shouldn't be modelled carrying
  // nothing. Half a day's food is the honest average over the hours you're walking.
  return Array.from({ length: days }, (_, i) => Math.round(carriedMg - perDay * (i + 0.5)));
}

// ---------------------------------------------------------------------------
// Where each day sits on the route, and what it has to say about itself.
//
// These are DECISIONS, not physics — which day gets a camp, when a derived climb
// is worth showing, when a row should stand down because a real pin already says
// the same thing. They lived as closures inside TrailPlanPanel, where they were
// untestable and, until this, untested: the component has no test of its own, and
// every rule below is one somebody could break without a single case going red.
// ---------------------------------------------------------------------------

export interface DayRange {
  fromM: number;
  toM: number;
}

/** Cumulative start/end for each day, in order. A day with no distance is a zero-
 *  width range at wherever the previous day left off, which is what makes it read
 *  as "unanswered" rather than "at the trailhead". */
export function dayRanges(dayDistancesM: number[]): DayRange[] {
  let run = 0;
  return dayDistancesM.map((d) => {
    const fromM = run;
    run += d;
    return { fromM, toM: run };
  });
}

/**
 * The climb (or descent) to SHOW for a day: the typed figure if there is one, else
 * the day's derived share of the route.
 *
 * The `distanceM != null` guard is the whole point. A derived climb is a day's SHARE
 * of the route, so it only says anything once the day has a share to take — without
 * this, a day you haven't given a distance to reads "0 ft", which is a measurement,
 * and states flat ground where there is only an unanswered question. Its distance
 * says "—"; its climb has to agree.
 */
export function shownHeightM(
  explicitM: number | null | undefined,
  distanceM: number | null | undefined,
  derivedM: number | undefined,
): number | undefined {
  return explicitM ?? (distanceM != null ? derivedM : undefined);
}

/** True when the figure on screen came from the route rather than from the user —
 *  the app marks a derived climb so it doesn't read as something you typed. */
export function heightIsDerived(
  explicitM: number | null | undefined,
  shownM: number | undefined,
): boolean {
  return explicitM == null && shownM != null;
}

export interface DayEnd {
  /** `camp` — you sleep here. `finish` — the route ends here. */
  kind: "camp" | "finish";
  alongM: number;
}

/**
 * How a day ends, if it ends anywhere worth drawing a row for.
 *
 * Camp and finish are the same question ("where does this day leave you") with two
 * answers, which is why one function settles it: the LAST day with any distance
 * finishes the walk, and every other day camps. "Last" is by distance rather than
 * index, so a trailing row you added but haven't filled in doesn't steal the finish
 * from the day that actually ends the walk.
 *
 * `hasRest` — ground past the last assigned day — turns the last day back into a
 * camp, because the route carries on past it and finishing there would be a lie.
 *
 * `endPinsAtM` stands the finish row down. A point-to-point route already STORES an
 * end pin and it files into this day; saying the same thing twice in two rows is
 * worse than not saying it, so the derived row yields to the real one. Within a
 * metre, because the two arrive by different arithmetic — one from the polyline's
 * length, one from the days summed. Takes the whole list and asks whether ANY of
 * them lands here, rather than trusting there to be exactly one.
 */
export function dayEnd(opts: {
  index: number;
  ranges: DayRange[];
  dayDistancesM: number[];
  hasRest: boolean;
  endPinsAtM?: readonly number[];
}): DayEnd | null {
  const { index, ranges, dayDistancesM, hasRest, endPinsAtM } = opts;
  const r = ranges[index];
  // a day with no distance yet occupies no ground, so it ends nowhere
  if (!r || r.toM <= r.fromM) return null;

  const isLast = !dayDistancesM.some((d, k) => k > index && d > 0);
  if (!isLast || hasRest) return { kind: "camp", alongM: r.toM };

  if (endPinsAtM?.some((m) => Math.abs(m - r.toM) <= 1)) return null;
  return { kind: "finish", alongM: r.toM };
}
