<script setup lang="ts">
import { HugeiconsIcon, type IconChild, type IconNode } from "~/utils/hugeicon";
import { ChevronDownIcon, Delete02Icon, DropletIcon, Fire02Icon, HelpCircleIcon, MountainIcon, RacingFlagIcon, RouteIcon, Stairs01Icon, Sun03Icon, TentIcon } from "@hugeicons/core-free-icons";
import type { ListSnapshot, Totals } from "~~/shared/types";
import { estimateDay, heightIsDerived, shownHeightM } from "~~/shared/tripPlan";
import { coolerByC, dayFactsForRanges, type DayFacts } from "~~/shared/dayFacts";
import { carryHours, dryCarries, longestCarryForDay, type DryCarry } from "~~/shared/dryCarry";
import { dayClimbs, parseProfile } from "~~/shared/profile";
import { MAX_DAYS } from "~~/shared/ops";
import { shiftIsoDate } from "~~/shared/calendar";
import { cumulativeM, decodePolyline, formatLatLon, pointAlong } from "~~/shared/polyline";
import { dayLabel } from "~~/shared/tripDay";
import { DAYLIGHT_MARGIN_H, daylightHours, formatDaylight, lightIsShort } from "~~/shared/daylight";
import { formatWeight } from "~~/shared/weights";
import type { BodyWeightUnit } from "~~/shared/trailDistance";
import {
  DEFAULT_BODY_G,
  bodyWeightFieldValue,
  distanceFieldValue,
  formatBodyWeight,
  formatDistance,
  formatDistancePadded,
  heightFieldValue,
  heightValue,
  parseDistanceM,
} from "~~/shared/trailDistance";
import { tripDays } from "~~/shared/foodPlan";
import { useTrailPlanRoute } from "~/composables/useTrailPlanRoute";
import { useTripLoadModel } from "~/composables/useTripLoadModel";

// Planning mode's body: the trip broken into days, and what the pack weighs on each.
//
// It takes the place of the gear, the way packing mode takes the place of the editable
// rows — planning asks a different question of the same list, and the rows would only be
// a long scroll between you and the answer. What stays put is the identity of what you're
// looking at: title, trail, distance, dates and the pack's weight are all above this and
// never move when you switch view.
const props = defineProps<{ snapshot: ListSnapshot; totals: Totals }>();

const c = useGearList();
const uid = useId();

const stored = computed(() => [...(props.snapshot.days ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));

/**
 * The days of the trip. The DATES already say how many there are, so the itinerary takes
 * its length from them rather than asking you to count the same thing twice.
 *
 * Rows past the stored ones are GHOSTS — real rows you can read and type into, with no
 * entity behind them yet. They materialise on first edit (see `ensureDay`), which is what
 * keeps setting dates from writing a pile of empty days into the list, and keeps a plan
 * you never touched from being something the reducer has to carry.
 *
 * THE DATES DECIDE. A trip is however many days its calendar says, and that is the one
 * control for it — so lengthening the range adds a day and shortening it takes one away.
 *
 * Shortening never destroys anything. The TripDay entities stay in the list whether or not
 * the range currently reaches them, so pulling the end date back and pushing it out again
 * brings the distances back exactly as they were. Only the number SHOWN follows the dates.
 *
 * Without dates at all there is nothing to count from, so a dateless list falls back to
 * however many days it has been given directly — which is also what every list written
 * before this behaved like.
 */
const days = computed(() => {
  const dated = tripDays(props.snapshot.startDate, props.snapshot.endDate) ?? 0;
  // Clamped to the reducer's own ceiling. Nothing stops a date picker describing a
  // two-year trip — setDate validates each end and never compares them — and without this
  // the rows past 60 rendered and accepted typing while the reducer silently dropped
  // their addDay, so every one of those edits landed on day 60 instead. A row you can
  // type into that isn't the row you're typing into is worse than no row.
  const n = Math.min(MAX_DAYS, dated || stored.value.length);
  return Array.from({ length: n }, (_, i) => stored.value[i] ?? null);
});

/**
 * One more day on the trip — by moving the END DATE, when there is one.
 *
 * The alternative, appending a TripDay, quietly created a second source of truth: the
 * calendar said four days and the list said five, and nothing on screen explained which
 * was right. Extending the range keeps one answer to "how long is this trip".
 */
function addDay() {
  const end = props.snapshot.endDate;
  const start = props.snapshot.startDate;
  if (!end || !start) return void c.addDay();
  if (days.value.length >= MAX_DAYS) return;
  c.setMeta({ endDate: shiftIsoDate(end, 1) });
}

/**
 * One fewer day — the mirror of addDay, and it has to move the calendar too or the two
 * controls immediately disagree about how long the trip is.
 *
 * The removed day's ROW is dropped and everything after it shifts up, which is what a
 * person means by deleting the second day of four. Then the range shortens by one, because
 * a four-day itinerary on a five-day calendar is the inconsistency this whole change is
 * for. A dateless list just loses the entity.
 */
function removeDay(i: number) {
  const d = stored.value[i];
  if (d) c.removeDay(d.id);
  const start = props.snapshot.startDate;
  const end = props.snapshot.endDate;
  if (!start || !end) return;
  // pull the END back, never the start: a trip's first day is the one thing about its
  // dates a person is sure of, and moving it would silently reschedule the whole walk
  const iso = shiftIsoDate(end, -1);
  // a one-day trip has nothing left to shorten; clear the range rather than invert it
  c.setMeta(iso < start ? { startDate: "", endDate: "" } : { endDate: iso });
}

/** A ghost row becoming real. Returns the id to patch. */
function ensureDay(i: number): string | null {
  const existing = stored.value[i];
  if (existing) return existing.id;
  // belt and braces with the clamp above: never ask for a day the reducer will refuse,
  // because the caller's fallback is "patch the last stored day" and that would write the
  // value onto the wrong day entirely
  if (i >= MAX_DAYS) return null;
  // fill any gap before it too, so sortOrder stays the position in the trip
  for (let k = stored.value.length; k <= i; k++) c.addDay();
  return null; // the patch lands on the next tick, once the op has applied
}
const {
  ascentUnit,
  bodyFieldValue,
  bodyG,
  bodyIsDefault,
  bodyUnit,
  commitBody,
  distanceUnit,
  headlineM,
  packMg,
  routeDescentDiffers,
  routeHeight,
  setBodyUnit,
  totalAscentM,
} = useTripLoadModel({
  snapshot: toRef(props, "snapshot"),
  totals: toRef(props, "totals"),
  days,
});

// ---- per-day estimates ----
// Everything here is MODELLED, and the `~` in the template says so on every figure. The
// mark isn't decoration: it survives copy-paste and the text exporters, where a colour or
// a tooltip would not, and a number that loses its mark gets quoted back as a fact.
const estimates = computed(() =>
  days.value.map((d, i) =>
    d?.distanceM
      ? estimateDay({
          distanceM: d.distanceM,
          ascentM: climbFor(i) ?? 0,
          descentM: descentFor(i),
          bodyKg: bodyG.value / 1000,
          loadKg: (packMg.value[i] ?? 0) / 1e6,
        })
      : null,
  ),
);
/**
 * "4–4.5 hr" — a BAND, because that is what the model actually knows.
 *
 * It used to say "4 h 11". Those minutes were arithmetic, not information: the estimate is
 * good to about ±20%, so quoting one claimed a precision nothing behind it has, and a
 * figure that precise gets quoted back as a fact. The calories beside it have always
 * rounded to the nearest hundred for exactly this reason; the clock was the holdout.
 *
 * A half-hour band containing the estimate, which is also the unit people plan in — you
 * leave at eight and expect to be in camp by one, not by 12:11.
 *
 * Under an hour it reads in minutes, because "0–0.5 hr" is not how anyone says twenty
 * minutes.
 */
function formatHours(h: number): string {
  const lo = Math.floor(h * 2) / 2;
  const hi = lo + 0.5;
  if (hi <= 1) return `${lo * 60}–${hi * 60} min`;
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return `${n(lo)}–${n(hi)} hr`;
}
// Rounded to the nearest 100. The model admits ±20%; a figure ending in 7 would claim a
// precision it does not have.
const roundKcal = (k: number) => Math.round(k / 100) * 100;
const tripKcal = computed(() =>
  estimates.value.reduce((s, e) => s + (e?.totalKcal ?? 0), 0),
);
const tripHours = computed(() => estimates.value.reduce((s, e) => s + (e?.hours ?? 0), 0));

// Route allocation has a separate lifecycle from this visual panel: it drives the
// profile, map, waypoint rows and boundary drags, while this component lays all of
// those answers out. Keep that model in one composable rather than between view blocks.
const {
  armedRange,
  arming,
  dayColors,
  dayDistancesM,
  dayEnds,
  finishDayIndex,
  grouped,
  hasRest,
  onBoundary,
  ranges,
  restFromM,
  restRange,
  routeFinishM,
  traceM,
  waypoints,
} = useTrailPlanRoute({
  snapshot: toRef(props, "snapshot"),
  stored,
  days,
  controller: c,
});

// ---- the route's shape ----
const profile = computed(() => parseProfile(props.snapshot.trailProfile));

// ---- what the day is like, read off the profile ----
// The camp's altitude, the high point, the longest climb and the steepest stretch
// (shared/dayFacts): derived, said in the estimate's ink, silent on a day with no
// distance. Nothing here is typed; the profile is public but this reads on /e for now.
const facts = computed(() =>
  dayFactsForRanges(profile.value, props.snapshot.trailDistanceM, ranges.value, props.snapshot.trailAscentM),
);
/** a height in the list's own unit, with its unit word */
const heightWord = (m: number) => `${heightValue(m, distanceUnit.value, distanceUnit.value === "mi" ? 10 : 1)} ${ascentUnit.value}`;
/** the lapse-rate rule of thumb, in the degrees the list's unit system speaks */
function coolerWord(aboveM: number): string {
  const c = coolerByC(aboveM);
  const v = distanceUnit.value === "mi" ? c * 1.8 : c;
  const n = Math.round(Math.abs(v));
  if (n < 1) return "";
  return `about ${n} °${distanceUnit.value === "mi" ? "F" : "C"} ${v > 0 ? "cooler" : "warmer"}`;
}
/** "Camp at 1,850 m, 650 m above the trailhead and about 4 °C cooler. High point 2,410 m." */
function campSentence(i: number, f: DayFacts): string {
  const end = i === finishDayIndex.value ? "Finish" : "Camp";
  const parts = [`${end} at ${heightWord(f.campM)}`];
  const above = Math.round(f.aboveTrailheadM);
  if (Math.abs(above) >= 10) {
    const cooler = coolerWord(f.aboveTrailheadM);
    parts.push(`${heightWord(Math.abs(above))} ${above > 0 ? "above" : "below"} the trailhead${cooler ? ` and ${cooler}` : ""}`);
  }
  let s = parts.join(", ") + ".";
  if (f.highM - f.campM >= 10) s += ` High point ${heightWord(f.highM)}.`;
  return s;
}
/** "Longest climb 620 m over 3.1 km, from 4.2 km. Steepest stretch 14% at 6.8 km." */
function groundSentence(f: DayFacts): string {
  const parts: string[] = [];
  if (f.climb) parts.push(`Longest climb ${heightWord(f.climb.gainM)} over ${formatDistance(f.climb.lengthM, distanceUnit.value)}, from ${formatDistance(f.climb.startM, distanceUnit.value)}.`);
  if (f.steepest) {
    const g = f.steepest.gradePct;
    parts.push(`Steepest stretch ${Math.abs(g)}% ${g < 0 ? "downhill" : "uphill"} at ${formatDistance(f.steepest.atM, distanceUnit.value)}.`);
  }
  return parts.join(" ");
}

// ---- the longest dry carry ----
// Between one water and the next, measured in full even across a night, from the pins
// already on the route (shared/dryCarry has the rules). The route's ends are sources
// too: you leave the trailhead with water and stop carrying at the finish. Owner-only
// by construction: the pins never ride a read path, so neither can this.
const waterPins = computed(() => waypoints.value.filter((w) => w.kind === "water"));
const carries = computed(() => dryCarries(waterPins.value, headlineM.value));
const dayHours = computed(() => estimates.value.map((e) => e?.hours));
// Each day's longest carry and its hours, once per day like dayEnds above, or null
// when the day has no carry to speak of. The row reads it six times; a function here
// would walk the carries and the ranges six times over to reach the same answer.
const dayCarries = computed(() =>
  ranges.value.map((r) => {
    const carry = longestCarryForDay(carries.value, r);
    return carry ? { carry, hours: carryHours(carry, ranges.value, dayHours.value) } : null;
  }),
);
/** where the carry starts, in words: the trailhead, or the pin by name or by distance */
function carryFromLabel(carry: DryCarry): string {
  const at = formatDistance(carry.fromM, distanceUnit.value);
  if (carry.from.kind === "trailhead") return "the trailhead";
  return carry.from.label ? `${carry.from.label} at ${at}` : `water at ${at}`;
}

/**
 * WHERE a point on the route actually is, worked out rather than looked up.
 *
 * A waypoint stores a DISTANCE and no coordinate, which is the single decision the whole
 * privacy design rests on: the array on its own says "camp at 6.2 miles" and discloses no
 * place at all. Only the route resolves it, and the route is owner-only.
 *
 * So this derives — it does not store. Showing a coordinate costs nothing; keeping one
 * would put a second copy of the most sensitive field in the list into `data`, where every
 * read path that already strips the geometry would have to strip it too, and would
 * eventually forget.
 */
const routePoints = computed(() =>
  props.snapshot.routeGeometry ? decodePolyline(props.snapshot.routeGeometry) : [],
);
// the route's spine, summed once per geometry rather than once per row per render —
// see the note on the walkers in shared/polyline.ts
const routeCum = computed(() => cumulativeM(routePoints.value));
const coordOf = (alongM: number) => {
  const at = routePoints.value.length ? pointAlong(routePoints.value, alongM, routeCum.value) : null;
  return at ? formatLatLon(at) : "";
};

function onPlace(alongM: number) {
  c.addWaypoint(alongM);
  // stays armed: one tap, one pin — drop three water sources in three taps, then name them
}

// ---- the light ----
/**
 * How much daylight each day has: sunrise to sunset at the middle of the day's stretch,
 * on the day's date (shared/daylight). Arithmetic on two things the list already holds,
 * so nothing is fetched and nothing is stored.
 *
 * Owner-only by construction rather than by a check: it needs the route's geometry,
 * which never rides a read path (rowToSnapshot), so the shared view simply has no
 * figure here. A dateless list, or a day with no distance, gets null rather than a
 * guess. The midpoint is the honest one place to ask: a day walks a stretch, and even
 * a long one moves the Sun's answer by well under a minute end to end.
 */
const dayDaylight = computed<(number | null)[]>(() => {
  const start = props.snapshot.startDate;
  if (!start || !routePoints.value.length) return days.value.map(() => null);
  return ranges.value.map((r, i) => {
    if (!(r.toM > r.fromM)) return null;
    const at = pointAlong(routePoints.value, (r.fromM + r.toM) / 2, routeCum.value);
    return at ? daylightHours(at, shiftIsoDate(start, i)) : null;
  });
});
/** the walk above runs past the day's light, less the margin (shared/daylight) */
const lightShort = (i: number) => lightIsShort(estimates.value[i]?.hours, dayDaylight.value[i]);
function lightTip(i: number): string {
  const base = "Sunrise to sunset at the middle of the day's route, from its coordinates and the date. Not a forecast, and no allowance for the terrain.";
  return lightShort(i)
    ? `${base} The walking time leaves under ${DAYLIGHT_MARGIN_H} hours of it to spare, so the day may end in the dark.`
    : base;
}

// Naming a day lives in shared/tripDay.ts — a shared list shows the itinerary too, and
// the two views must agree on what a day is called.
const dayOrdinal = (i: number) => dayLabel(i, props.snapshot.startDate);

/** Hand lengths in the icon set's 24-unit box; the minute hand reads longer, as on a face. */
const MINUTE_HAND = 5;
const HOUR_HAND = 3.4;

/** A point on the dial, clockwise from twelve, as an SVG coordinate pair. */
function polar(angle: number, length: number): string {
  return `${(12 + length * Math.sin(angle)).toFixed(2)} ${(12 - length * Math.cos(angle)).toFixed(2)}`;
}

/**
 * A clock face whose hands read the estimate beside it.
 *
 * Hugeicons' free set has no hour family — Clock01…05 all carry the identical hand path
 * (`M12 8V12L14 14`, ten past twelve) and differ only in the dial, so none of them can be
 * picked to match a duration. The icon prop takes a plain array though, so the hand is
 * computed here against the same 24-unit box the rest of the set draws in.
 *
 * Rounded to the nearest hour, and 12 rather than 0 for anything under half an hour,
 * because a face with both hands straight up reads as no time at all.
 */
function clockIcon(hours: number | undefined): IconNode {
  // NO HANDS when there is no estimate, and this is the whole reason the parameter is
  // optional. A day with no distance has no estimate — `estimates[i]` is null, which the
  // figure beside this already knew, because it prints "—". This did not: it read
  // `.hours` off the null and threw during render, taking the panel with it. A blank
  // itinerary is the DEFAULT state of a trip whose dates are set and whose distances
  // aren't, so that was every new plan.
  //
  // An empty dial rather than no icon: the cell still shows "—", and dropping the glyph
  // would pull the column out of line with every other row. A face with no hands states
  // no time, which is exactly the claim.
  const dial: IconChild = ["circle", { cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "1.5", key: "0" }];
  if (hours == null) return [dial];
  // Nearest HALF hour, so a 4 h 39 day reads half past four rather than rounding to five
  // and losing the difference between it and a 4 h 05 one. Never fewer than one half —
  // both hands straight up reads as no time at all rather than as a short day.
  const halves = Math.max(1, Math.round(hours * 2));
  const onHalf = halves % 2 === 1;
  const h = (halves / 2) % 12 || 12; // 12 rather than 0 at the wrap
  const rad = (deg: number) => deg * (Math.PI / 180);
  // The hour hand CREEPS with the minutes — at half past it sits between the two hours,
  // which is what a real face does and what makes the half-hour variants read as halves
  // rather than as a minute hand that came loose.
  const hour = polar(rad((h % 12) * 30), HOUR_HAND);
  const minute = polar(onHalf ? rad(180) : 0, MINUTE_HAND);
  return [
    dial,
    ["path", {
      d: `M${minute}L12 12L${hour}`,
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "1",
    }],
  ];
}


// Days collapse the way folders do, and remember it the same way — per id, in
// localStorage, never in the list. A plan you come back to should open the way you left
// it, and a long itinerary is exactly the thing you want to fold up.
const dayCollapse = usePersistedCollapse("gear.day.");
const collapsed = ref<Record<string, boolean>>({});
onMounted(() => {
  const next: Record<string, boolean> = {};
  // stored days only — a ghost has no id to remember a collapse against. Storage
  // blocked reads as expanded, like a folder.
  for (const d of stored.value) {
    if (dayCollapse.isCollapsed(d.id)) next[d.id] = true;
  }
  collapsed.value = next;
});
function toggleDay(id: string) {
  const now = !collapsed.value[id];
  collapsed.value = { ...collapsed.value, [id]: now };
  dayCollapse.set(id, now);
}

/**
 * Each day's climb, READ OFF the profile rather than typed — the route already knows it,
 * so asking twice is asking for a disagreement.
 *
 * A typed value still wins: `ascentM` on the day is the override, and the derived figure
 * only fills the gap. That's the same rule the trail's own distance follows, and it means
 * a GPX can't overwrite something somebody entered deliberately.
 */
const derivedClimbs = computed(() =>
  dayClimbs(
    profile.value,
    dayDistancesM.value,
    props.snapshot.trailDistanceM,
    props.snapshot.trailAscentM,
  ),
);
// A derived climb is the day's SHARE of the route, so it only says anything once the day
// has a share to take. Without this a day you haven't given a distance to reads "0 ft" —
// which is a measurement, and states flat ground where there is only an unanswered
// question. Its distance says "—"; its climb has to agree.
const climbFor = (i: number) =>
  shownHeightM(days.value[i]?.ascentM, days.value[i]?.distanceM, derivedClimbs.value[i]?.ascentM);
const climbIsDerived = (i: number) => heightIsDerived(days.value[i]?.ascentM, climbFor(i));
// The matching descent. Nothing in the app writes TripDay.descentM — there is no field
// for it — so without this every day fell back to estimateDay's default of "descends
// exactly what it climbs", while the real figure sat unused in derivedClimbs one line
// above. On a route that ends lower than it starts, that default is simply wrong.
const descentFor = (i: number) =>
  shownHeightM(days.value[i]?.descentM, days.value[i]?.distanceM, derivedClimbs.value[i]?.descentM);

// One commit for both metre fields. Distance reads in the trip's km/mi; ascent is
// a HEIGHT and reads in metres or feet, never the km/mi beside it — same parser,
// the fallback unit is the whole difference.
async function commitDayMetres(id: string | null, field: "distanceM" | "ascentM", e: Event) {
  if (!id) { await nextTick(); id = stored.value[stored.value.length - 1]?.id ?? null; if (!id) return; }
  const raw = (e.target as HTMLInputElement).value.trim();
  const unit = field === "distanceM" ? distanceUnit.value : distanceUnit.value === "mi" ? "ft" : "m";
  // "" and NOT undefined, spelled out per field. The patch is JSON on its way to
  // the server and JSON.stringify drops undefined keys, so clearing a day's figure
  // changed it locally and was overwritten by the very next echo — it looked like
  // the server refusing the edit, when the server was never told. See DayPatch;
  // tests/dayClear.test.ts pins each field's literal to this sentinel shape.
  c.updateDay(
    id,
    field === "distanceM"
      ? { distanceM: raw ? (parseDistanceM(raw, unit) ?? "") : "" }
      : { ascentM: raw ? (parseDistanceM(raw, unit) ?? "") : "" },
  );
}

// The two field formatters are shared/trailDistance.ts's: feet to the nearest 10 and
// ungrouped so the value parses back (heightFieldValue), and a distance padded to at
// least one decimal so the column holds its width (distanceFieldValue's `pad`). The
// reasoning for both lives beside them there.
const ascentValue = (m: number | undefined) => heightFieldValue(m, distanceUnit.value);
const distanceValue = (m: number | undefined) => distanceFieldValue(m, distanceUnit.value, { pad: true });
</script>

<template>
  <section class="plan" aria-label="Trip plan">
    <!-- The headline is the DISTANCE, taking the slot weight holds in the other two
         views: planning is a question about the route, and the route's length is what you
         are moving around when you shuffle days.
         It has earned the display size where an estimate would not have. This figure is
         entered, or exactly summed from what was entered — no model, no assumption, no
         default. When the burn estimates land they stay small on purpose; giving the
         least certain number on the page the most typographic mass is the inversion this
         whole panel is built to avoid. -->
    <!-- The big distance used to live here. It is one Headline in GearEditor now, shared
         with the weight the other two views show — the same element, so switching view
         changes the number without the figure unmounting and re-counting under you. -->

    <!-- THE FIGURES ROW, in the seat the totals row holds in the other two views.
         Flipping between Gear and Trip should look like one number changing and one
         row of small figures changing under it — not like two different pages. So this is
         the first thing under the headline in both, and what differs (rows here, a chart
         and a map there) starts below it. -->
    <!-- Only the figures nothing else on the page states. The day COUNT and the
         miles-per-day average both left with the same reasoning: the date range names the
         days and every row carries its own distance, so a chip restating either was
         summarising a summary. -->
    <div class="plan__chips">
      <!-- The ROUTE's climb, beside the estimates derived from it. Not the sum of the
           days' typed ascents, which is a different and usually smaller number — this is
           what the whole walk climbs. -->
      <span v-if="snapshot.trailAscentM" class="chip">
        <span class="t-label">Elevation gain</span>
        <span class="t-num">{{ routeHeight(snapshot.trailAscentM) }} <span class="t-muted">{{ ascentUnit }}</span></span>
      </span>
      <!-- only when it is a DIFFERENT fact — on a loop it equals the climb by definition -->
      <span v-if="routeDescentDiffers" class="chip">
        <span class="t-label">Elevation loss</span>
        <span class="t-num">{{ routeHeight(snapshot.trailDescentM) }} <span class="t-muted">{{ ascentUnit }}</span></span>
      </span>
      <span v-if="totalAscentM > 0" class="chip">
        <span class="t-label">Climb</span>
        <span class="t-num">{{ ascentValue(totalAscentM) }} <span class="t-muted">{{ ascentUnit }}</span></span>
      </span>
      <!-- the pack, kept in view because the totals bar stands down in this mode -->
      <span v-if="totals.carriedMg > 0" class="chip">
        <span class="t-label">Carried</span>
        <!-- the unit as its own element, the way the totals bar does it: baked into the
             formatted string it can't take the lesser ink, so "lb" sat at full weight
             beside every other unit on the panel stepping back -->
        <span class="t-num">{{ formatWeight(totals.carriedMg, snapshot.displayUnit, { withUnit: false }) }} <span class="t-muted">{{ snapshot.displayUnit }}</span></span>
      </span>
      <!-- The trip's own estimates, up here with the facts they're derived from rather
           than in a sentence at the foot. They step back in colour: the chips to their
           left are measured, these are worked out.

           The BURN says "Estimated", because it is a single figure and needs a word to
           hedge it. The time doesn't: it reads as a range, and a range is already the
           hedge — "Estimated 17–17.5 hr" says it twice.

           WALKING TIME, not "time". On a four-day hike "time" reads as how long the trip
           takes, which is four days, not seventeen hours. This figure is time on your
           feet: it counts no camp, no breaks, no waiting out weather — the tooltip on the
           day rows has always said so, and the label should not need the tooltip to stop
           being wrong. -->
      <span v-if="tripHours > 0" class="chip chip--est">
        <span class="t-label">Walking time</span>
        <span class="t-num">{{ formatHours(tripHours) }}</span>
      </span>
      <span v-if="tripHours > 0" class="chip chip--est">
        <span class="t-label">Estimated burn</span>
        <span class="t-num">{{ roundKcal(tripKcal).toLocaleString() }} <span class="t-muted">kcal</span></span>
      </span>
    </div>

    <!-- The route's shape, cut into days. Directly under the figure it belongs to. -->
    <TrailProfile
      v-if="profile.length && days.length"
      :profile="profile"
      :day-distances-m="dayDistancesM"
      :distance-unit="distanceUnit"
      :total-distance-m="headlineM"
      :ascent-m="snapshot.trailAscentM"
      :descent-m="snapshot.trailDescentM"
      :facts="false"
      @trace="traceM = $event"
    />
    <!-- Where that shape actually is. Directly under the profile, in the same day
         colours, so the two marks read as one answer rather than two charts.

         `Lazy` + `v-if` is the whole cost control: Leaflet and its stylesheet are a
         separate ~45 KB chunk that is only REQUESTED when a list has a route. A packing
         list with no GPX never downloads a byte of it, which is the right default for a
         feature secondary to the actual job here. -->
    <LazyRouteMap
      v-if="snapshot.routeGeometry"
      :geometry="snapshot.routeGeometry"
      :day-distances-m="dayDistancesM"
      :waypoints="waypoints"
      :trace-m="traceM"
      :finish-m="routeFinishM"
      :armed-range="armedRange"
      @place="onPlace"
      :distance-unit="distanceUnit"
      @move="(m) => c.updateWaypoint(m.id, { alongM: m.alongM })"
      @boundary="onBoundary"
      @rename="(m) => c.updateWaypoint(m.id, { label: m.label })"
      @remove="(id) => c.removeWaypoint(id)"
    >
      <!-- Only while the map fills the window, where the day rows are behind it and out
           of reach. Same `arming` ref the rows drive, so this is a second SURFACE for one
           piece of state, never a second copy of it — and the map dims to whichever is
           chosen either way. -->
      <template #overlay>
        <div class="plan__armbar" role="radiogroup" aria-label="Day to place a waypoint on">
          <button
            v-for="(d, i) in dayDistancesM"
            v-show="d > 0"
            :key="i"
            type="button"
            class="plan__armchip"
            :class="{ 'is-on': arming === i }"
            role="radio"
            :aria-checked="arming === i"
            @click="arming = arming === i ? null : i"
          >
            <span class="plan__armdot" :style="{ background: dayColors[i] }" aria-hidden="true" />
            Day {{ i + 1 }}
          </button>
          <button
            v-if="hasRest"
            type="button"
            class="plan__armchip"
            :class="{ 'is-on': arming === 'rest' }"
            role="radio"
            :aria-checked="arming === 'rest'"
            @click="arming = arming === 'rest' ? null : 'rest'"
          >
            <span class="plan__armdot plan__armdot--rest" aria-hidden="true" />
            Rest
          </button>
        </div>
      </template>
    </LazyRouteMap>
    <!-- THE DAY COLOURS, keyed — the same treatment the folder colours get under the weight
         bar in Gear, because it is the same problem: a mark carries colour, and colour that
         has to be learned from the mark itself is decoration. The map draws a coloured leg
         and the profile draws a coloured ridge, and until now nothing said which day was
         which except hovering a leg.
         Under the MAP rather than the profile, though both use these colours, because one
         key answers for both and it belongs after the last thing that spends them. -->
    <ul v-if="snapshot.routeGeometry && days.length" class="daykey">
      <li v-for="(d, i) in days" :key="d?.id ?? i" class="daykey__item">
        <span class="swatch" :style="{ background: dayColors[i] }" />
        <span>Day {{ i + 1 }}</span>
        <!-- The SAME formatter the day's own row uses, not formatDistance. The two sat a
             decimal place apart — "8.6 mi" in the key against "8.63 mi" in the row it keys —
             and one number written two ways reads as two numbers. distanceValue is what the
             day's field shows, so the key quotes the row rather than recomputing it. -->
        <span class="t-sm t-muted daykey__dist">
          {{ distanceValue(dayDistancesM[i]) }} {{ distanceUnit }}
        </span>
      </li>
    </ul>
    <!-- Empty state names what's missing rather than showing an empty table. -->
    <!-- the one line the carry needs before it can say anything: with no water marked
         the whole route is one stretch, and that is not a finding. Said ONCE, here,
         rather than on every day. It sits ABOVE the empty-state paragraph so that
         paragraph's v-else (the days list) keeps its partner. -->
    <p v-if="snapshot.routeGeometry && days.length && !waterPins.length" class="t-sm plan__carryhint">
      Mark water on the route and each day shows its longest dry carry.
    </p>
    <p v-if="!days.length" class="plan__note t-sm">
      Break the trip into days to see what each one asks of you, and what the pack weighs
      when you shoulder it that morning.
    </p>

    <ol v-else class="plan__days">
      <li v-for="(d, i) in days" :key="d?.id ?? `ghost-${i}`" class="plan__day">
        <!-- The heading takes the FOLDER treatment — a day groups a stretch of the walk
             the way a folder groups gear, so it reads at the same level. Unlike a folder
             it is NOT renameable: a day is already named by the trip, and the calendar
             names it better than a typed string would. "Monday, Day 2" is what a person
             says out loud, and it stays correct when the dates move.

             `label` survives on TripDay, and updateDay still accepts it, so the field
             round-trips through export and import untouched. What's gone is the
             affordance, not the data: naming can come back without a migration. -->
        <header class="plan__dayhead">
          <h2 class="t-clip plan__name">{{ dayOrdinal(i) }}</h2>
          <button
            type="button"
            class="plan__collapse plan__collapse--tight"
            :aria-expanded="!collapsed[d?.id ?? '']"
            :aria-label="`${collapsed[d?.id ?? ''] ? 'Expand' : 'Collapse'} ${dayOrdinal(i)}`"
            @click="d && toggleDay(d.id)"
          >
            <HugeiconsIcon :icon="ChevronDownIcon" class="plan__chev2" :class="{ 'is-collapsed': collapsed[d?.id ?? ''] }" :size="20" :stroke-width="2" />
          </button>
          <button
            type="button"
            class="btn btn--icon btn--ghost plan__del plan__del--end"
            :title="`Remove day ${i + 1}`"
            :aria-label="`Remove day ${i + 1}`"
            @click="removeDay(i)"
          >
            <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="1.5" />
          </button>
        </header>

        <!-- The data reads as one line of glyph-and-figure pairs, the way an item row
             does: what you TYPE first, then what follows from it. -->
        <div v-if="!collapsed[d?.id ?? '']" class="plan__data">
          <span class="plan__cell">
            <HugeiconsIcon :icon="RouteIcon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <input
              class="field field--num plan__num"
              inputmode="decimal"
              :value="distanceValue(d?.distanceM)"
              :aria-label="`Distance on day ${i + 1}, in ${distanceUnit}`"
              placeholder="—"
              @change="commitDayMetres(d?.id ?? ensureDay(i), 'distanceM', $event)"
            />
            <span class="t-muted">{{ distanceUnit }}</span>
          </span>

          <!-- Climb comes off the GPX when there is one, and is muted to say so. Typing
               over it makes it yours, and the value stops being derived.

               THE DROP RIDES IN THIS CELL, not in one of its own. Up and down over the same
               ground is one fact read twice, and while the drop had its own cell the climb
               still held a 7.5rem column in front of it — so a short climb left forty-odd
               pixels of nothing between the two halves of a pair, wider than the gap
               between unrelated columns. Sharing the cell puts them a hair apart and hands
               the column back to the figures after them, which the drop's own variable
               width had been shunting around anyway. -->
          <span class="plan__cell plan__cell--climb" :class="{ 'is-derived': climbIsDerived(i) }">
            <HugeiconsIcon :icon="Stairs01Icon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <input
              class="field field--num plan__num"
              inputmode="decimal"
              :value="ascentValue(climbFor(i))"
              :aria-label="`Elevation gain on day ${i + 1}, in ${ascentUnit}`"
              placeholder="—"
              @change="commitDayMetres(d?.id ?? ensureDay(i), 'ascentM', $event)"
            />
            <span class="t-muted">{{ ascentUnit }}</span>
            <!-- Not typeable, unlike the two above: nothing in the app writes a day's
                 descent by hand, and a figure that is only ever derived should look like
                 what it is. The same staircase, mirrored: it climbs left-to-right, so its
                 reflection descends. One glyph for one idea, and the pair reads as a
                 matched set in a way two different arrows never did. -->
            <span v-if="descentFor(i) != null" class="plan__drop">
              <HugeiconsIcon :icon="Stairs01Icon" class="plan__gl plan__gl--down" :size="16" :stroke-width="2" aria-hidden="true" />
              <span class="t-num">{{ ascentValue(descentFor(i)) }} <span class="t-muted">{{ ascentUnit }}</span></span>
            </span>
          </span>

          <!-- Read-only, and worked out rather than measured — so it carries the `~` AND
               a (?) you can actually reach. A bare title= is invisible to a phone and to
               a keyboard; Tooltip is the app's own affordance and answers both. -->
          <span class="plan__cell plan__cell--est">
            <HugeiconsIcon :icon="clockIcon(estimates[i]?.hours)" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <!-- no `~` on this one: the RANGE is the hedge, and "~4–4.5" says it twice.
                 The calories beside it keep theirs, being a single figure. -->
            <span class="t-num">{{ estimates[i] ? formatHours(estimates[i]!.hours) : "—" }}</span>
            <Tooltip v-if="estimates[i]" text="Walking time only, no breaks. Pace follows the gradient and the weight of your pack." preferred-placement="top">
              <button type="button" class="plan__why" aria-label="How the moving time is worked out">
                <HugeiconsIcon :icon="HelpCircleIcon" :size="14" :stroke-width="2" aria-hidden="true" />
              </button>
            </Tooltip>
          </span>

          <!-- How much light there is to walk in: sunrise to sunset at the middle of the
               day's stretch, on its date. Arithmetic rather than an estimate, so it carries
               no `~` and no band. It takes the caution ink when the walking time before it
               runs past the light less a margin (lightIsShort): a walk that ends in the dark
               is the one thing about a day that a week's notice fixes. Only a dated list
               with a route has it; everything else renders nothing rather than a guess. -->
          <span
            v-if="dayDaylight[i] != null"
            class="plan__cell plan__cell--est plan__cell--light"
            :class="{ 'is-short': lightShort(i) }"
          >
            <HugeiconsIcon :icon="Sun03Icon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <span class="t-num">{{ formatDaylight(dayDaylight[i]!) }}</span>
            <span class="visually-hidden"> of daylight</span>
            <Tooltip :text="lightTip(i)" preferred-placement="top">
              <button type="button" class="plan__why" aria-label="How the daylight is worked out">
                <HugeiconsIcon :icon="HelpCircleIcon" :size="14" :stroke-width="2" aria-hidden="true" />
              </button>
            </Tooltip>
          </span>

          <span class="plan__cell plan__cell--est">
            <HugeiconsIcon :icon="Fire02Icon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <span class="t-num">{{ estimates[i] ? `~${roundKcal(estimates[i]!.totalKcal).toLocaleString()}` : "—" }}</span>
            <Tooltip v-if="estimates[i]" :text="`Walking and resting, at ${formatBodyWeight(bodyG, bodyUnit)}${bodyIsDefault ? ' (assumed)' : ''}. Good to about ±20%.`" preferred-placement="top">
              <button type="button" class="plan__why" aria-label="How the calories are worked out">
                <HugeiconsIcon :icon="HelpCircleIcon" :size="14" :stroke-width="2" aria-hidden="true" />
              </button>
            </Tooltip>
          </span>

        </div>

        <!-- What the day is like, read off the profile: two derived sentences in the
             estimate's ink. The first is where you end up and how high; the second is
             the climb you'll remember and the steepest bit. Both go quiet when there
             is nothing to say (flat ground, a day with no distance). -->
        <template v-if="!collapsed[d?.id ?? ''] && dayDistancesM[i] && facts[i]">
          <p class="t-sm plan__fact">
            <HugeiconsIcon :icon="i === finishDayIndex ? RacingFlagIcon : TentIcon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <span>{{ campSentence(i, facts[i]!) }}</span>
          </p>
          <p v-if="groundSentence(facts[i]!)" class="t-sm plan__fact">
            <HugeiconsIcon :icon="MountainIcon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <span>{{ groundSentence(facts[i]!) }}</span>
          </p>
        </template>

        <!-- The longest carry this day walks any part of: a sentence, not a cell, because
             it names a place. Measured in full even when it straddles the night; the
             hours follow each day's own pace, and are left out when part of the carry
             falls on ground with no estimate. -->
        <p v-if="!collapsed[d?.id ?? ''] && dayDistancesM[i] && dayCarries[i]" class="t-sm plan__fact">
          <HugeiconsIcon :icon="DropletIcon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
          <span>
            Longest carry
            <span class="t-num">{{ formatDistance(dayCarries[i]!.carry.toM - dayCarries[i]!.carry.fromM, distanceUnit) }}</span><template v-if="dayCarries[i]!.hours != null">, <span class="t-num">{{ formatHours(dayCarries[i]!.hours!) }}</span></template>,
            from {{ carryFromLabel(dayCarries[i]!.carry) }}.
          </span>
        </p>

        <!-- The pins on THIS day's stretch, and how you add one — the place in a day that
             "Add an item" holds in a folder, and deliberately the same gesture: arming
             from here clamps the tap to this day's leg, so what you add lands in the day
             you asked from rather than wherever the finger came down.

             Only a day with a distance gets it. A blank day owns no ground — its climb
             already reads "—" for exactly this reason — and an add button that could never
             produce a row under it is worse than no button at all. -->
        <div
          v-if="!collapsed[d?.id ?? ''] && snapshot.routeGeometry && dayDistancesM[i]"
          class="plan__wps"
        >
          <!-- ONE list, pins and the night together, because the hairlines between them
               are the thing that makes this read as a day's contents rather than as two
               stacked blocks — and a rule can only run between siblings. -->
          <ol
            v-if="grouped.byDay[i]?.length || dayEnds[i]"
            class="plan__wplist"
          >
            <WaypointRow
              v-for="w in grouped.byDay[i]"
              :key="w.id"
              :waypoint="w"
              :distance-unit="distanceUnit"
              :coord="coordOf(w.alongM)"
            />
            <!-- ONE row for either kind of day's end, coming LAST because that is the
                 order you meet them in: you pass the spring and the col, and then you
                 arrive. A camp (tent) on every day the route runs past — or, on the
                 last day, THE FINISH (flag), which answers the same question: where
                 does this day leave you. Neither is deletable or re-kindable, because
                 it isn't a pin — deleting it would mean deleting the day. On a loop
                 the finish is the trailhead again, which is why it is drawn rather
                 than stored.
                 Both kinds are NAMED through the day's own `label` — free of conflict,
                 because a day has exactly one end, so the two can never want the field
                 at once. The placeholder (not a typed-over name) is what says which
                 kind an empty row is. -->
            <!-- It wears the waypoint row's own classes (WaypointRow.vue's unscoped
                 .wprow recipe): the same grid, the same cells, so the two can't line
                 up differently. What's this row's alone is named plan__camp*. -->
            <li v-if="dayEnds[i]" class="wprow">
              <input
                class="field wprow__name"
                :value="d?.label ?? ''"
                :placeholder="dayEnds[i]!.kind === 'camp' ? 'Where you sleep' : 'Where you end up'"
                maxlength="120"
                :aria-label="`Name for the ${dayEnds[i]!.kind === 'camp' ? 'camp' : 'finish'} at the end of day ${i + 1}`"
                @change="(e) => d && c.updateDay(d.id, { label: (e.target as HTMLInputElement).value.trim() })"
              />
              <!-- The glyph alone, in the same cell the pins' toggles occupy and boxed to
                   the same width, so it sits exactly where a toggle's glyph sits. The word
                   went: the row is a camp (or the finish) because the itinerary made it
                   one, not because anybody chose it, so naming the kind here was labelling
                   a control that isn't one. Its label says so for a screen reader. -->
              <span
                class="wprow__fixedkind plan__campkind"
                role="img"
                :aria-label="dayEnds[i]!.kind === 'camp' ? `Camp at the end of day ${i + 1}` : 'The end of the route'"
              >
                <HugeiconsIcon :icon="dayEnds[i]!.kind === 'camp' ? TentIcon : RacingFlagIcon" :size="16" :stroke-width="2" aria-hidden="true" />
              </span>
              <span class="t-sm wprow__coord">{{ coordOf(dayEnds[i]!.alongM) }}</span>
              <span class="t-sm wprow__dist">{{ formatDistancePadded(dayEnds[i]!.alongM, distanceUnit) }}</span>
              <!-- the delete column, left empty: a day's end is the end of a day, and
                   removing it would mean removing the day. The cell stays so every other
                   column in the list still lines up through this row. -->
              <span class="wprow__del" aria-hidden="true" />
            </li>
          </ol>
          <!-- the add row, carrying the same rule and the same padding as a row above it,
               so it reads as the NEXT row rather than a button parked under a list —
               exactly what .folder__add does under a folder's items -->
          <div class="plan__wpadd" :class="{ 'is-first': !grouped.byDay[i]?.length && dayEnds[i]?.kind !== 'camp' }">
            <button type="button" class="folder__addbtn" @click="arming = arming === i ? null : i">
              {{ arming === i ? "Tap the route to place it" : "Add a waypoint" }}
            </button>
          </div>
        </div>
      </li>
    </ol>

    <!-- The ground no day has claimed: the grey tail on the chart above, which is real
         route and holds pins like any other stretch.
         It is also where everything lands before an itinerary exists — on a fresh GPX no
         day has a distance yet, so this IS the route, and it says so. -->
    <div
      v-if="snapshot.routeGeometry && (hasRest || grouped.rest.length)"
      class="plan__rest"
    >
      <h2 class="plan__restname">{{ restFromM > 0 ? "Rest of the route" : "The route" }}</h2>
      <div class="plan__wps">
        <ol v-if="grouped.rest.length" class="plan__wplist">
          <WaypointRow
            v-for="w in grouped.rest"
            :key="w.id"
            :waypoint="w"
            :distance-unit="distanceUnit"
            :coord="coordOf(w.alongM)"
          />
        </ol>
        <button
          v-if="hasRest"
          type="button"
          class="folder__addbtn"
          @click="arming = arming === 'rest' ? null : 'rest'"
        >
          {{ arming === "rest" ? "Tap the route to place it" : "Add a waypoint" }}
        </button>
      </div>
    </div>

    <!-- The assumption, never silent. It sits with the estimates it feeds rather than in
         a footnote, and it retires its own "assuming" the moment a real number is set. -->
    <p v-if="tripHours > 0" class="plan__assume t-sm">
      <label :for="`${uid}-body`">Your weight</label>
      <span class="plan__field">
        <input
          :id="`${uid}-body`"
          class="field field--num plan__num plan__bodynum"
          inputmode="decimal"
          :value="bodyFieldValue"
          :placeholder="bodyWeightFieldValue(DEFAULT_BODY_G, bodyUnit)"
          @change="commitBody"
        />
        <!-- kg or lb, pickable — the third field to take the same three rules (two units
             only, absent follows the weight system this device works in, the stored
             grams never move). A body in ounces is not a thing anyone wants to read. -->
        <OptionMenu
          :options="BODY_WEIGHT_UNIT_OPTIONS"
          :current="bodyUnit"
          label="Body weight unit"
          title="Change unit"
          @pick="(u) => setBodyUnit(u as BodyWeightUnit)"
        >
          <template #trigger="{ open }">
            <span class="t-muted">{{ bodyUnit }}</span>
            <HugeiconsIcon :icon="ChevronDownIcon" :size="12" :stroke-width="2" />
          </template>
        </OptionMenu>
      </span>
      <span v-if="bodyIsDefault" class="plan__assumed">assumed</span>
    </p>
    <!-- What the MARK means, and nothing else. The ±20% and the model behind it live in
         the (?) beside each figure, where they're asked for — repeating them here was the
         same sentence twice. But the tilde still has to be explained somewhere you can't
         miss: a tooltip is discovered, not read, and an unexplained character stuck to a
         number is worse than no mark at all. -->
    <p v-if="tripHours > 0" class="plan__accuracy t-sm">~ is worked out, not measured.</p>

    <!-- Adds a day to the CALENDAR, not a loose row beside it. The date range is the one
         place a trip's length is set, so this pushes the end date out by one rather than
         creating a day the dates don't know about. A list with no dates has no range to
         extend, so it still gets a plain day. -->
    <div class="plan__addwrap">
      <button type="button" class="plan__add" @click="addDay">Add a day</button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.plan {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* no padding at the TOP: the headline above already carries the gap, and two of them
     stacked is what put the chart a whole 48px clear of the number it belongs to */
  padding-block: 0 var(--space-4);
}
.plan__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
}
.plan__note {
  color: var(--ink-3);
  max-width: 46ch;
}
.plan__days {
  /* The itinerary starts a --folder-gap below the figures, the same distance one folder
     sits from the next in the editor — and the same distance the days keep between
     themselves, which was already true and made the 16px above the first one look like a
     mistake. Reached from the panel's own --space-4 gap, the identical arithmetic
     .editor__addfolder does for exactly this reason. */
  margin: calc(var(--folder-gap, var(--space-6)) - var(--space-4)) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--folder-gap, var(--space-6));
}
/* A day is a folder-shaped thing: a heading at title size, its own actions, then its
   contents underneath. Same rhythm, so the two read as siblings — the one difference is
   that this heading is written by the calendar rather than typed. */
.plan__dayhead {
  display: flex;
  align-items: baseline;
  /* .folder__head's gap and its 4px to the body, not near-misses of them — the two
     headers sit in the same column one mode apart, and an 8px gap here read as a
     different rhythm rather than a different view. */
  gap: var(--space-4);
  margin-bottom: var(--space-1);
}
/* Sized to its text so the chevron stays hugged against it rather than being pushed to
   the column's far edge — the same reason the folder title does it. */
.plan__name {
  flex: 0 1 auto;
  min-width: 0;
  /* A folder's name is an <input>, which builds a 41px box out of a 33px line and 4px
     of padding. This is a heading and would otherwise sit at 26px, putting every day
     header 15px shorter than every folder header in the same column. Matching the box
     is what makes the two modes feel like one page. */
  padding-block: var(--space-1);
  line-height: 1.5;
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  color: var(--ink);
}
/* the chevron rides with the NAME, as a folder's does — it belongs to the thing it
   folds, not to the row's trailing actions */
.plan__collapse--tight {
  margin-left: calc(var(--space-2) * -1 + 2px);
}
.plan__del {
  flex: none;
  color: var(--ink-3);
}
/* …and only the delete goes to the far edge */
.plan__del--end {
  margin-left: auto;
}
/* the row's data, as glyph-and-figure pairs — an item row's grammar at day scale */
/* The day's figures line up DOWN the list, not just across one row.
 *
 * Fixed cell widths rather than a grid: every day is its own element, so separate grids
 * wouldn't share columns, and `subgrid` would mean restructuring the list into one grid
 * that the headers and pack bars also live in. A width per kind of figure gets the columns
 * for a fraction of the change, and these figures are bounded — a day is at most three
 * digits of distance and five of climb, which is what the widths are sized from.
 */
.plan__data {
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}
.plan__cell {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  /* the column. Wide enough for the longest real figure plus its unit and a (?), so a
     row never pushes the ones beside it out of line */
  min-width: 7.5rem;
  color: var(--ink-2);
  /* the editor's row size — .field pins its inputs to a literal 1rem for the iOS
     zoom rule, and the text beside them has to sit on the same line as those */
  font-size: var(--text-base);
}
/* estimates sit a step back from the figures you entered — the `~` carries the claim,
   this only keeps the eye on what's yours */
.plan__cell--est {
  color: var(--ink-3);
}
/* a derived sentence under the day's figures (the camp, the ground, the carry), in the
   estimate's ink, with a glyph for its subject so a stack of them scans by shape */
.plan__fact {
  margin-top: var(--space-1);
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  color: var(--ink-3);
}
.plan__fact .plan__gl {
  /* the glyph's box sits on the baseline row; nudge it to the text's optical centre */
  position: relative;
  top: 0.2em;
}
/* the once-only hint above the days, same ink, same size, no glyph */
.plan__carryhint {
  margin-top: var(--space-2);
  color: var(--ink-3);
}
/* THE CLIMB AND ITS DROP SHARE ONE CELL, so they share one column.
   Every other cell holds a different kind of fact, and the fixed width lines those up down
   the list. These two are one fact read twice — up and down over the same ground, drawn as
   a staircase and its own reflection. Giving the drop a cell of its own was not enough on
   its own: the climb kept its full 7.5rem in front of it, so "970 ft" left some forty
   pixels of nothing before the drop's glyph — a wider gap than the one between columns
   holding unrelated figures, which is precisely backwards.
   Wide enough for five digits of climb, the pair's own gap, and five of drop. */
.plan__cell--climb {
  min-width: 10rem;
}
/* A HAIR, not a column: narrower than the --space-3 between real columns, so the eye reads
   these two as one thing. --space-1 on top of the cell's own --space-1 between its parts. */
.plan__drop {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: var(--space-1);
  /* derived, like every other estimate on the row */
  color: var(--ink-3);
}
/* a climb read off the GPX rather than typed */
.plan__cell.is-derived .plan__num {
  color: var(--ink-3);
}
/* The light, when the walk runs past it: the figure and its sun step FORWARD to full
   ink, from the estimate's step back. Not --danger: that token is spent on destruction
   alone (tokens.scss), and the chrome is monochrome by rule, so a caution here is the
   same move every emphasis on this site makes, a darker ink. On a row of stepped-back
   figures one at full strength is the thing the eye lands on, and the (?) beside it
   says why. */
.plan__cell--light.is-short,
.plan__cell--light.is-short .plan__gl {
  color: var(--ink);
}
/* the (?) — quiet until wanted, and a real button so it's reachable by keyboard and
   by touch, unlike the title= it replaces */
.plan__why {
  /* the glyph annotates the figure rather than belonging to it, so it sits a full step
     away — at --space-1 it read as a superscript on the number */
  margin-left: var(--space-2);
  display: inline-flex;
  color: var(--ink-3);
  cursor: help;
  transition: color var(--dur) var(--ease);
}
.plan__why:hover,
.plan__why:focus-visible {
  /* full ink, the house treatment for a quiet action. The resting state is --ink-3 and
     NOT --ink-ghost: the ghost token's own definition says not to reuse it below the
     page-title size, and at 14px it made the only sign an explanation exists a 1.35:1
     smudge — invisible to exactly the reader who needed the explanation. */
  color: var(--ink);
}
.plan__collapse {
  flex: none;
  display: inline-flex;
  color: var(--ink-3);
  cursor: pointer;
}
.plan__chev2 {
  transition: transform var(--dur) var(--ease);
}
.plan__chev2.is-collapsed {
  transform: rotate(-90deg);
}
.plan__gl {
  flex: none;
  color: var(--ink-3);
}
/* Units and other trailing small text take --ink-3, the lesser ink.
 *
 * NOT `.t-muted`, which is --ink-2 and therefore DARKER — beside a derived figure (also
 * --ink-3) it made the unit louder than the number it qualifies, which is backwards. One
 * token for every unit on the panel, so "ft" reads the same weight wherever it appears. */
.plan__cell .t-muted,
.plan__chips .t-muted,
.plan__assume .t-muted {
  color: var(--ink-3);
}
/* mirrored, not a second icon — see the template */
.plan__gl--down {
  transform: scaleX(-1);
}
/* .field + .field--num carry the shape (uncontained, no fill, caret-as-focus, the
   tabular numerals and the iOS 16px rule) — an item row's weight box and this are the
   same object, so they are the same atom. Only the width is local: a day's figures are
   short, and .field is width:100%. */
/* Sized to CONTENT, and left-aligned. `.field--num` right-aligns inside a fixed box,
   which is right in the item grid where weights form a column — here the figures sit in
   a flex row behind their own glyph, so a fixed box just parked a gap between the icon
   and its number. Nothing lines up vertically for that alignment to serve. */
/* Sized to its CONTENT, with the column width living on the cell instead.
 *
 * The fixed width belongs one level up. Put on the input, it padded short values out to
 * the widest — "3130" in a 5ch box left a space before "ft", breaking the number away
 * from its own unit. On the cell, the slack lands at the END of the column where it is
 * just spacing, and the figure and its unit stay a single object. */
.plan__num {
  padding-inline: 0;
  width: auto;
  field-sizing: content;
  min-width: 2ch;
  max-width: 7ch;
  text-align: left;
}
/* Literally the "Add folder" treatment — same type, same inks, same distance from the
   run of things above it. .editor__addfolder reaches --space-7 from a --space-4 parent
   gap and this has the identical arithmetic to do, so it does it the identical way. */
.plan__addwrap {
  align-self: flex-start;
  margin-top: calc(var(--space-7) - var(--space-4));
}
.plan__add {
  cursor: pointer;
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
/* full ink on hover, the house treatment for a quiet text action */
.plan__add:hover {
  color: var(--ink);
}
/* EVERY chip reads at the same weight, measured or estimated.
 *
 * The estimates used to step back a tone from the figures beside them, on the reasoning
 * that one kind is measured and the other worked out. That distinction is now carried by
 * the words — "Estimated time", "Estimated burn" — which says it better than a shade
 * does, and leaves the row reading as one set of figures rather than two classes of
 * citizen. `--est` survives only as a hook for anything that needs the difference.
 *
 * Tabular numerals go too: they exist to make a COLUMN of figures line up, and these sit
 * in a row where nothing is above or below anything. Proportional digits set better. */
.plan__chips .chip .t-num {
  color: var(--ink-3);
  font-variant-numeric: normal;
}
.plan__assume,
.plan__accuracy {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
  color: var(--ink-3);
}
.plan__accuracy {
  max-width: 56ch;
}
.plan__assumed {
  color: var(--ink-3);
}
.plan__bodynum {
  width: 4rem;
}

/* The day picker that floats over the expanded map. White-on-map like Leaflet's own
   controls, because the basemap stays light in both themes — see RouteMap. */
.plan__armbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-px);
  padding: var(--space-1);
  border-radius: var(--radius-2);
  background: var(--map-paper);
  box-shadow: var(--map-control-shadow);
}
.plan__armchip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-1);
  font-size: var(--text-chrome);
  color: var(--map-ink-3);
  white-space: nowrap;
  cursor: pointer;
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss). The armed
   state below is the only thing on screen naming the day the next tap lands in, so a
   latched hover plate beside it would put two chips forward at once. */
@media (hover: hover) and (pointer: fine) {
  .plan__armchip:hover {
    background: var(--map-control-hover);
    color: var(--map-ink);
  }
}
/* armed is a STATE, and it has to hold its plate whether the pointer is on it or not —
   it is the only thing on screen saying which day the next tap lands in */
.plan__armchip.is-on {
  background: var(--map-control-selected);
  color: var(--map-ink);
  font-weight: 600;
}
.plan__armdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
/* the unclaimed stretch has no day colour, because it is nobody's */
.plan__armdot--rest {
  background: var(--map-unassigned);
}

/* A day's pins, sitting under its figures the way a folder's items sit under its name —
   and taking the folder's add row verbatim (.folder__addbtn is the shared atom), because
   "Add a waypoint" here and "Add an item" there are the same affordance in the same place
   doing the same job. The rule line comes with it: the pins read as the day's contents
   rather than as a second block stuck to the bottom of it. */
.plan__wps {
  margin-top: var(--space-3);
  /* NO gap and no padding of its own: the rows carry their own rhythm below, exactly as a
     folder's items do. A gap here would sit on top of that and make every rule line float
     between two bands of space instead of dividing two rows. */
  display: flex;
  flex-direction: column;
}
/* THE GEAR LIST'S RHYTHM, verbatim (.folder__items > * in atoms/folder.scss): --space-2
   above and below each row, a hairline between siblings and never above the first. These
   are the same kind of list doing the same kind of job one mode over, and they were set at
   a different density — a --space-1 stack with no rules, which read as a cluster of chips
   rather than as a list you scan down. */
.plan__wplist > *,
.plan__wpadd {
  padding-block: var(--space-2);
}
.plan__wplist > * + *,
.plan__wpadd {
  border-top: 1px solid var(--line);
}
/* …and when the day has no pins yet, the add row IS the first row, so it drops its rule —
   the same exception .folder__add--first makes for an empty folder. */
.plan__wpadd.is-first {
  border-top: 0;
}
/* The night, on the SAME grid as a waypoint row — it wears .wprow and its cells
   (WaypointRow.vue's unscoped recipe; see --wprow-cols below for the tracks the list
   hands both). Its own template only lined it up with itself, which put its distance
   somewhere the pins' never was. The trailing action cell is empty; there is nothing
   to delete here. What's left here is the one thing the camp says differently: */
/* ink, not a category hue — it is the itinerary talking, the same thing the handle on
   the map says by being paper-filled rather than solid */
.plan__campkind {
  color: var(--ink-3);
}
/* Lifted wholesale from .catbar__legend, deliberately: "the same treatment" means the same
   spacing and the same hanging indent, not something that merely resembles it. */
.daykey {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
  margin-top: var(--space-3);
}
/* TEXT FLOW rather than a flex row, for the reason CategoryBar gives at length: a wrapped
   entry in a flex row centres its dot against the whole block instead of against the line
   it belongs to. The hanging indent keeps a wrapped line under the NAME, not under the dot. */
.daykey__item {
  padding-inline-start: calc(var(--swatch) + var(--space-2));
  text-indent: calc(-1 * (var(--swatch) + var(--space-2)));
}
.daykey__dist {
  margin-inline-start: var(--space-2);
}
/* the atom draws the dot and sits it on the label's cap box (atoms/controls.scss —
   both used to be restated here); only the gap to the label is the day key's */
.daykey .swatch {
  margin-inline-end: var(--space-2);
}
.plan__wplist {
  /* ONE COLUMN SET for every row in the day — the pins and the night alike. Declared here
     rather than in either row so neither can drift from the other: kind, name, coordinate,
     distance and the delete button each line up straight down the list, which is the only
     thing that makes a distance comparable to the one above it.
     Custom properties pierce scoped styles, so WaypointRow reads this from its own file. */
  /* FIXED at both ends, not `auto`. Every row is its own grid, so an `auto` column sizes
     to that row's own content and nothing lines up between them: the camp's single tent
     resolved to 62px against the pins' three buttons at 100, and the whole list stepped in
     and out. The two icon columns are the ones whose contents differ, so they are the ones
     that have to be told a width. The rest can stay content-sized — the name takes the
     slack, and the coordinate and distance are tabular text of a fixed shape.
     NAME FIRST. It is what you read the row by, so it takes the left edge where the eye
     lands; the kind toggles are what you set once and then stop looking at. */
  /* THE TRACK FOLLOWS THE POINTER, because the buttons in it do. An icon button is
     --icon-btn under a mouse and --tap under a thumb (controls.scss grows it for the
     44px target). Pinned at --icon-btn, these tracks were 32px boxes holding 44px
     buttons — and a grid track narrower than its content doesn't clip it, it lets it
     paint over the neighbour. The delete button hung off the end of the row and the
     second kind toggle sat on top of the coordinate. */
  --wprow-btn: var(--icon-btn);
  --wprow-cols:
    minmax(0, 1fr)
    calc(var(--wprow-btn) * 2 + var(--space-px))
    auto
    auto
    var(--wprow-btn);
  /* Named even here, where the order is just the source order, because a cell asks for its
     area BY NAME in both files — and an area name with nothing to resolve against doesn't
     quietly fall back to auto placement, it invents an implicit track per cell. Naming the
     one-line arrangement too is what keeps the narrow one (below) a change of ARRANGEMENT
     rather than a change of mechanism. */
  --wprow-areas: "name kind coord dist del";
  /* WIDER THAN THE ROW'S OTHER SPACING, and it comes out of slack the name column has in
     abundance — at this width the name is a 1fr track with hundreds of pixels spare while
     the coordinate, the distance and the delete button are pressed into a block at the
     right edge. Eight pixels between two numbers reads as one number that happens to have
     a space in it. */
  --wprow-gap: var(--space-5);
  align-self: stretch;
  display: flex;
  flex-direction: column;
  /* no gap — the rows' own padding-block is the rhythm, so the rule lines land between
     two rows rather than floating in the middle of a space */
}
/* A thumb gets the bigger boxes, so the row gets the bigger tracks. */
@media (pointer: coarse) {
  .plan__wplist {
    --wprow-btn: var(--tap);
  }
}
/* TWO LINES, and the split is by KIND of thing rather than by what happens to fit.
   In one line the name is the column that pays for every other one: at 375px it had
   collapsed to TEN PIXELS — a field you cannot see, let alone type in — while the
   coordinate beside it kept its full 171.
   So the first line is what the row IS and what you can do to it: the name, its kind, and
   the delete button. The second is what you READ off it: where the pin sits, and how far
   along it is. Pushed to opposite ends of their line, because they are two facts and not
   one string; sat side by side at the end of a line they read as a single run of digits.
   The alternative — name alone on top, all four cells beneath — does not fit. Four cells
   plus their gaps need about 373px of the 356 a phone has, which is how the collision got
   here in the first place. */
@media (max-width: $bp-stack) {
  .plan__wplist {
    --wprow-cols:
      minmax(0, 1fr)
      calc(var(--wprow-btn) * 2 + var(--space-px))
      var(--wprow-btn);
    --wprow-areas:
      "name kind del"
      "coord dist dist";
    /* left edge, against the distance's right — the air between them IS the separation */
    --wprow-coord-justify: start;
    /* back to the tighter gap: the slack that paid for --space-5 above is what the name is
       using now, and at this width the row has none to spare */
    --wprow-gap: var(--space-2);
  }
}
/* The unclaimed stretch is a day-shaped thing without being a day, so it takes the day's
   spacing and its heading size but never its figures — there is nothing to estimate about
   ground nobody has planned. */
.plan__rest {
  margin-top: var(--folder-gap, var(--space-6));
}
.plan__restname {
  padding-block: var(--space-1);
  line-height: 1.5;
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  /* a step back from a day's heading: this names the ground left over, not a plan */
  color: var(--ink-3);
}
</style>
