<script setup lang="ts">
import { HugeiconsIcon, type IconChild, type IconNode } from "~/utils/hugeicon";
import { ChevronDownIcon, Delete02Icon, Fire02Icon, HelpCircleIcon, RacingFlagIcon, RouteIcon, Stairs01Icon, TentIcon } from "@hugeicons/core-free-icons";
import type { ListSnapshot, Totals, Waypoint } from "~~/shared/types";
import { burnDownMg, dayEnd, dayRanges, estimateDay, heightIsDerived, shownHeightM } from "~~/shared/tripPlan";
import { dayClimbs, parseProfile } from "~~/shared/profile";
import { MAX_DAYS } from "~~/shared/ops";
import { dayColorSequence } from "~~/shared/categories";
import { decodePolyline, formatLatLon, pointAlong } from "~~/shared/polyline";
import { dayLabel } from "~~/shared/tripDay";
import { isWaterName } from "~~/shared/water";
import { lineMg, effectiveClassification, formatWeight } from "~~/shared/weights";
import type { BodyWeightUnit } from "~~/shared/trailDistance";
import {
  DEFAULT_BODY_G,
  M_PER_UNIT,
  bodyWeightFieldValue,
  formatBodyWeight,
  formatDistancePadded,
  heightUnitFor,
  heightValue,
  parseBodyWeightG,
  parseDistanceM,
  resolveDistanceUnit,
} from "~~/shared/trailDistance";
import { tripDays } from "~~/shared/foodPlan";

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
  const next = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000);
  c.setMeta({ endDate: next.toISOString().slice(0, 10) });
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
  const next = new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000);
  const iso = next.toISOString().slice(0, 10);
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
const distanceUnit = computed(() => resolveDistanceUnit(props.snapshot.trailDistanceUnit));

const totalDistanceM = computed(() => days.value.reduce((s, d) => s + (d?.distanceM ?? 0), 0));
// The bigger of the route's own length and what the days add up to.
//
// The route leads, because it says something true from the first moment rather than
// sitting at zero until an itinerary is typed, and because the days are shares OF it —
// which is what leaves a remainder for the unassigned stretch (see dayDistancesM).
//
// But `max`, not the route alone: an itinerary can legitimately add up to more than the
// straight-line route — a side trip, an out-and-back to water — and a figure a person
// typed must never be quietly discarded in favour of one read off a file.
// NOT tripHeadline(snapshot).metres, though the arithmetic looks identical. That sums the
// list's STORED days; this sums the days the calendar currently shows. They differ on a
// list whose date range was shortened, because the entities behind the hidden days survive
// (see `days`) — and the chart below has to be scaled to the ground it actually draws.
const headlineM = computed(() =>
  Math.max(props.snapshot.trailDistanceM ?? 0, totalDistanceM.value),
);
/**
 * The ROUTE's climb, exact.
 *
 * Not ascentValue, which rounds feet to the nearest 10. That rounding is right for the
 * day fields, where the store is integer metres and an editable figure would otherwise
 * round-trip 690 into 689; it is wrong here, where the figure is read-only, measured
 * across the full track, and sits beside a chart whose spoken description states it
 * exactly. 10,250 next to 10,246 is the same number disagreeing with itself.
 */
const routeHeight = (m: number | undefined) =>
  m == null ? "" : heightValue(m, distanceUnit.value);

/** Whether the route's drop is its own fact, or the climb restated (which a loop guarantees). */
const routeDescentDiffers = computed(
  () =>
    props.snapshot.trailDescentM != null &&
    props.snapshot.trailAscentM != null &&
    props.snapshot.trailDescentM !== props.snapshot.trailAscentM,
);
const totalAscentM = computed(() => days.value.reduce((s, d) => s + (d?.ascentM ?? 0), 0));

/**
 * Consumable weight that actually DEPLETES — everything classed consumable, minus water.
 *
 * Water refills; it doesn't get eaten. Counting it as burned down would make the late days
 * weightlessly cheap, which is the opposite of true on a dry section. The test is the
 * item's name (shared/water.ts owns that rule), which is why this lives here rather than
 * in computeTotals — weights.ts can't import water.ts without a cycle.
 */
const burnableMg = computed(() => {
  const water = props.snapshot.items
    .filter((i) => isWaterName(i.name))
    .filter((i) => effectiveClassification(i, props.snapshot.folders) === "consumable")
    .reduce((s, i) => s + lineMg(i), 0);
  return Math.max(0, props.totals.consumableMg - water);
});

/**
 * The pack at the middle of each day, heaviest first.
 *
 * No longer DRAWN — the per-day bar and figure came off the row. They restated the trip's
 * "Carried" chip once per day with a burn-down nobody had asked to see, and a row read by
 * scanning one column doesn't want a seventh figure that turns it into a table.
 *
 * This survives because the ESTIMATE still needs it: what a day costs depends on what you
 * are carrying across it — the midpoint, not the morning's load, which would over-read
 * every day.
 */
const packMg = computed(() => burnDownMg(props.totals.carriedMg, burnableMg.value, days.value.length));

// ---- the walker ----
// Set once per DEVICE, not per list — a body weight belongs to the person, not to the
// trip, so re-entering it on every list was asking the wrong question. See
// useBodyWeight: it never reaches the server, which is why nothing here has to be
// stripped from a read path.
//
// Optional, with a STATED default. `isDefault` is what keeps that honest: the control
// reads "assuming 70 kg" until someone sets one, rather than sitting pre-filled with 70,
// because a pre-filled field looks like something you already confirmed.
const body = useBodyWeight(props.snapshot.displayUnit);
const bodyUnit = body.unit;
const bodyG = body.value;
const bodyIsDefault = body.isDefault;
const bodyFieldValue = computed(() =>
  body.stored.value ? bodyWeightFieldValue(body.stored.value, bodyUnit.value) : "",
);
function commitBody(e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim();
  body.set(raw ? parseBodyWeightG(raw, bodyUnit.value) : null);
}

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

// ---- the route's shape ----
const profile = computed(() => parseProfile(props.snapshot.trailProfile));
// Each day's share of the ground, for cutting the profile into coloured stretches.
//
// A blank day is ZERO, not an even slice of what's left. Ground you haven't assigned to a
// day isn't shared out among the blank ones — it's simply unassigned, and the chart draws
// that tail grey (see TrailProfile). Enter 4 miles of a 20-mile route and the first 4 are
// your Day 1; the other 16 are not yet anybody's, and colouring them would say otherwise.
const dayDistancesM = computed(() => days.value.map((d) => d?.distanceM ?? 0));

// The colours the days wear on the chart and on the map's legs — read from the one
// sequence all three use, so a chip can't say "Day 2" in a colour day 2 isn't drawn in.
const dayColors = computed(() => dayColorSequence(days.value.length));

// ---- the pins ----
/**
 * Where each day's stretch begins and ends along the route.
 *
 * The same cut the elevation chart and the map's legs make — days laid end to end from the
 * start — so a pin, a coloured leg and a coloured stretch of chart all answer "which day
 * is this" identically. A blank day is zero-width, which is the point: it owns no ground
 * until it has a distance, and so it can hold no pins.
 */
// cumulative from/to per day — shared/tripPlan, so it is tested rather than inlined
const ranges = computed(() => dayRanges(dayDistancesM.value));

/** Ground past the last assigned day — still on the route, not yet anybody's. */
const restFromM = computed(() => ranges.value.at(-1)?.toM ?? 0);
const restRange = computed(() => ({ fromM: restFromM.value, toM: props.snapshot.trailDistanceM ?? 0 }));
const hasRest = computed(() => restRange.value.toM > restRange.value.fromM + 1);

/**
 * The pins, in ROUTE ORDER — which is the only order they have. A waypoint carries no
 * sortOrder because its distance along the line already answers "which comes first", and
 * a stored order could disagree with the map.
 */
const waypoints = computed(() =>
  [...(props.snapshot.waypoints ?? [])].sort((a, b) => a.alongM - b.alongM),
);

/**
 * The pins sorted into the days that contain them — a DERIVED grouping, never a stored one.
 *
 * A waypoint has no dayId on purpose: `removeDay` has no cascade because nothing else
 * references a day, and adding the first reference would break that. Chainage answers the
 * same question for free, and it stays right when the boundaries move — retype day 2's
 * distance and the pins redistribute, exactly as the chart's colours do.
 */
const grouped = computed(() => {
  const byDay: Waypoint[][] = ranges.value.map(() => []);
  const rest: Waypoint[] = [];
  // HALF-OPEN, [fromM, toM) — a pin on a boundary belongs to the day that STARTS there,
  // not the one that ends there. Days share those boundaries exactly, and the closed
  // version put a pin placed at the head of day 3 into day 2's list: the arithmetic was
  // right and the answer was still the wrong day to a reader. The zero-width test keeps a
  // blank day (which owns no ground at all) from swallowing the start of the route.
  const dayFor = (alongM: number) => {
    const i = ranges.value.findIndex(
      (r) => r.toM > r.fromM && alongM >= r.fromM && alongM < r.toM,
    );
    if (i >= 0) return i;
    // The one place the half-open rule needs help: the very end of the last day is a
    // boundary with nothing after it to hand the pin to, and the finish of a walk plainly
    // belongs to the day you finish on — not to leftover ground.
    if (restFromM.value > 0 && alongM === restFromM.value) {
      return ranges.value.findLastIndex((r) => r.toM > r.fromM);
    }
    return -1;
  };
  for (const w of waypoints.value) {
    const i = dayFor(w.alongM);
    if (i >= 0) byDay[i]!.push(w);
    else rest.push(w);
  }
  return { byDay, rest };
});

/**
 * Which stretch is armed for placing — a day index, or "rest" for the unclaimed ground.
 *
 * Off by default: the map is a pan surface too, and a pin dropped by a mis-registered drag
 * is worse than one more tap to ask for. Arming from a DAY is what makes this the same
 * gesture as "Add an item" in a folder — the thing you add lands in the thing you asked
 * from, which is why the tap is clamped to that day's stretch rather than going wherever
 * the finger landed.
 */
const arming = ref<number | "rest" | null>(null);

/**
 * How far along the route the elevation chart's cursor is, passed straight to the map.
 *
 * The two marks draw the same walk twice — once as a shape, once as a place — and until
 * now you had to hold a spot on one of them in your head while looking for it on the
 * other. A profile can't tell you WHERE its steep mile is, and a map can't tell you which
 * of its bends is the climb. Tracing one and watching the other answers both.
 *
 * It lives here rather than in either component because neither owns it: the chart knows
 * the distance and nothing about the ground, the map knows the ground and has no cursor.
 * The panel already holds the pair, so it holds the one number that joins them — the same
 * chainage a waypoint is stored in, which is why nothing has to be converted.
 *
 * NOT persisted, and deliberately: it is where a pointer is this second.
 */
const traceM = ref<number | null>(null);

// A route imported before the trailhead existed carries no start pin, and neither end is
// a kind you can place by hand — so without this those lists could never grow one. Fires
// when the geometry first arrives, which covers a list being opened and a route being
// dropped on it alike; a second run adds nothing (see ensureRouteEnds).
watch(
  () => props.snapshot.routeGeometry,
  (geo) => {
    if (geo) c.ensureRouteEnds();
  },
  { immediate: true },
);
const armedRange = computed(() => {
  if (arming.value === null) return null;
  if (arming.value === "rest") return restRange.value;
  const r = ranges.value[arming.value];
  if (!r) return null;
  // A METRE SHORT of the boundary, and only for a day.
  //
  // The map clamps a stray tap to the near end of the armed stretch; the grouping above
  // is half-open. Clamping to `toM` exactly would therefore park the pin on the first
  // metre of the NEXT day — arming day 3, tapping wide and watching the row appear under
  // day 4. A metre is far below anything the route can resolve (the geometry is
  // simplified to ~125 m between stored points), so it costs nothing real and it makes
  // the two rules agree. "Rest" keeps its full range: the route's end is nobody's
  // boundary.
  return { fromM: r.fromM, toM: Math.max(r.fromM, r.toM - 1) };
});
/**
 * A day boundary dropped somewhere new — TWO days rewritten in one gesture.
 *
 * Day `index` now ends where the handle landed, and the next day that owns any ground
 * starts there. Their sum is unchanged, which is what keeps every other day still: this is
 * a way of trading miles between two neighbours, not of changing how long the trip is.
 *
 * Two ops, dispatched together on the drop. Not one per pointer move — a drag would be a
 * hundred autosaves and a hundred separate undos, which is the rule every continuous
 * gesture in this app follows.
 *
 * The LAST boundary has no neighbour to trade with, so it lengthens or shortens its own
 * day and the unclaimed tail absorbs the difference. That asymmetry is the point of it.
 */
function onBoundary(b: { index: number; alongM: number }) {
  const from = ranges.value[b.index]?.fromM;
  const id = stored.value[b.index]?.id;
  if (from == null || !id) return;
  const len = Math.max(1, Math.round(b.alongM - from));
  // the next day that owns ground; blanks in between own none and can't give any up
  const nextI = dayDistancesM.value.findIndex((d, k) => k > b.index && d > 0);
  const next = nextI >= 0 ? ranges.value[nextI] : undefined;
  const nextId = nextI >= 0 ? stored.value[nextI]?.id : undefined;
  c.updateDay(id, { distanceM: len });
  if (next && nextId) {
    c.updateDay(nextId, { distanceM: Math.max(1, Math.round(next.toM - b.alongM)) });
  }
}

/**
 * Where each day ENDS, as a row of its own — the same point the tent handle marks on the
 * map, so what you can drag up there has a line down here saying what it is and how far in.
 *
 * Derived from the itinerary, exactly as the handle is: no entity, no id, nothing stored.
 * The last day only gets one if the route runs on past it — otherwise its "camp" is the
 * end of the walk, which is somewhere you go home from rather than sleep at.
 */
/**
 * Where the LAST day ends — a finish, which is not a camp.
 *
 * Every other day ends at a night and the camp row draws it. The last one ends at the end of the
 * walk, and that was the one thing this panel never said: the final day printed its figures
 * and then nothing at all, because it has no camp and frequently no pins either.
 *
 * DERIVED, like the camp beside it, rather than a stored waypoint — and on a loop that is
 * the whole point. A loop finishes at the trailhead it left, so a stored finish pin would
 * put two markers on one coordinate, which is exactly what seedRouteEnds refuses to do. A
 * ROW costs nothing and stacks nothing, and the map still carries one flag.
 *
 * Exactly complementary to the camp: a day has a camp or a finish, never both and never
 * neither — unless there is unclaimed ground after it, in which case the walk does not end
 * there and neither mark is true.
 */
// Camp and finish are one decision with two answers — which day ends where, and
// whether a stored end pin already says it. shared/tripPlan.dayEnd settles it, and
// is tested there; this reads the answer once per day, and the rows (which ask
// several times each) read this.
const dayEnds = computed(() =>
  ranges.value.map((_, i) =>
    dayEnd({
      index: i,
      ranges: ranges.value,
      dayDistancesM: dayDistancesM.value,
      hasRest: hasRest.value,
      endPinsAtM: waypoints.value.filter((w) => w.kind === "end").map((w) => w.alongM),
    }),
  ),
);

/** The one day that has a finish, for the map — the rows ask per day, the map asks once. */
const routeFinishM = computed(() => dayEnds.value.find((e) => e?.kind === "finish")?.alongM ?? null);

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
const coordOf = (alongM: number) => {
  const at = routePoints.value.length ? pointAlong(routePoints.value, alongM) : null;
  return at ? formatLatLon(at) : "";
};

function onPlace(alongM: number) {
  c.addWaypoint(alongM);
  // stays armed: one tap, one pin — drop three water sources in three taps, then name them
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
const collapsed = ref<Record<string, boolean>>({});
onMounted(() => {
  const next: Record<string, boolean> = {};
  // stored days only — a ghost has no id to remember a collapse against
  for (const d of stored.value) {
    try {
      if (localStorage.getItem(`gear.day.${d.id}`) === "1") next[d.id] = true;
    } catch {
      /* private mode / no storage — default expanded, like a folder */
    }
  }
  collapsed.value = next;
});
function toggleDay(id: string) {
  const now = !collapsed.value[id];
  collapsed.value = { ...collapsed.value, [id]: now };
  try {
    if (now) localStorage.setItem(`gear.day.${id}`, "1");
    else localStorage.removeItem(`gear.day.${id}`);
  } catch {
    /* not worth reporting */
  }
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
  // "" and NOT undefined. The patch is JSON on its way to the server and
  // JSON.stringify drops undefined keys, so clearing a day's figure changed it
  // locally and was overwritten by the very next echo — it looked like the server
  // refusing the edit, when the server was never told. See DayPatch.
  const v = raw ? (parseDistanceM(raw, unit) ?? "") : "";
  c.updateDay(id, field === "distanceM" ? { distanceM: v } : { ascentM: v });
}

const ascentUnit = computed(() => heightUnitFor(distanceUnit.value));
// Metres round-trip exactly; FEET don't, because the store is integer metres — type 690
// and it comes back 689. Rounding display feet to the nearest 10 hides an artefact that
// isn't a real disagreement, and it's the more honest figure besides: consumer elevation
// is noisy to ±5–10 m, so a climb quoted to the foot claims precision nothing has.
const ascentValue = (m: number | undefined) => {
  if (m == null) return "";
  // String, NOT heightValue — heightValue groups for reading ("7,316") and this is a field
  // value that has to parse back. Same conversion, different presentation.
  if (distanceUnit.value !== "mi") return String(Math.round(m));
  return String(Math.round(m / M_PER_UNIT.ft / 10) * 10);
};
const distanceValue = (m: number | undefined) => {
  if (m == null) return "";
  const n = Number((m / M_PER_UNIT[distanceUnit.value]).toFixed(2));
  // At least one decimal, so "9.0" and "9.8" are the same width and the unit sits hard
  // against the figure instead of drifting a character away on whole numbers. PADDED, not
  // rounded — 9.85 keeps both places, because this field round-trips through the store and
  // forcing one decimal would quietly turn it into 9.9 the next time it saved.
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
};
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
         Flipping between Gear and Planning should look like one number changing and one
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
          <h2 class="plan__name">{{ dayOrdinal(i) }}</h2>
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
            <Tooltip v-if="estimates[i]" text="Walking time only — no breaks. Pace follows the gradient and the weight of your pack." preferred-placement="top">
              <button type="button" class="plan__why" aria-label="How the moving time is worked out">
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
            <li v-if="dayEnds[i]" class="plan__camp">
              <input
                class="field plan__campfield"
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
                class="plan__campkind"
                role="img"
                :aria-label="dayEnds[i]!.kind === 'camp' ? `Camp at the end of day ${i + 1}` : 'The end of the route'"
              >
                <HugeiconsIcon :icon="dayEnds[i]!.kind === 'camp' ? TentIcon : RacingFlagIcon" :size="16" :stroke-width="2" aria-hidden="true" />
              </span>
              <span class="t-sm plan__coord">{{ coordOf(dayEnds[i]!.alongM) }}</span>
              <span class="t-sm plan__campdist">{{ formatDistancePadded(dayEnds[i]!.alongM, distanceUnit) }}</span>
              <!-- the delete column, left empty: a day's end is the end of a day, and
                   removing it would mean removing the day. The cell stays so every other
                   column in the list still lines up through this row. -->
              <span class="plan__campdel" aria-hidden="true" />
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
          @pick="(u) => body.setUnit(u as BodyWeightUnit)"
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
  margin: 0;
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
  padding: 0;
  list-style: none;
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
  margin: 0;
  /* A folder's name is an <input>, which builds a 41px box out of a 33px line and 4px
     of padding. This is a heading and would otherwise sit at 26px, putting every day
     header 15px shorter than every folder header in the same column. Matching the box
     is what makes the two modes feel like one page. */
  padding-block: var(--space-1);
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
/* the (?) — quiet until wanted, and a real button so it's reachable by keyboard and
   by touch, unlike the title= it replaces */
.plan__why {
  /* the glyph annotates the figure rather than belonging to it, so it sits a full step
     away — at --space-1 it read as a superscript on the number */
  margin-left: var(--space-2);
  display: inline-flex;
  padding: 0;
  border: 0;
  background: none;
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
  padding: 0;
  border: 0;
  background: none;
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
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  font-family: var(--font);
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
  margin: 0;
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
  background: #fff;
  box-shadow: 0 1px 4px #0000001f;
}
.plan__armchip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-1);
  background: none;
  font-family: inherit;
  font-size: var(--text-chrome);
  color: #555;
  white-space: nowrap;
  cursor: pointer;
}
.plan__armchip:hover {
  background: #0000000d;
  color: #111;
}
/* armed is a STATE, and it has to hold its plate whether the pointer is on it or not —
   it is the only thing on screen saying which day the next tap lands in */
.plan__armchip.is-on {
  background: #00000014;
  color: #111;
  font-weight: 600;
}
.plan__armdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
/* the unclaimed stretch has no day colour, because it is nobody's */
.plan__armdot--rest {
  background: #9a9a9a;
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
/* The night, on the SAME grid as a waypoint row — see --wprow-cols below. Its own
   template only lined it up with itself, which put its distance somewhere the pins' never
   was. The trailing action cell is empty; there is nothing to delete here. */
.plan__camp {
  display: grid;
  grid-template-columns: var(--wprow-cols);
  /* the list decides the arrangement — one line wide, two lines narrow */
  grid-template-areas: var(--wprow-areas, "name kind coord dist del");
  align-items: center;
  /* row gap only matters once the row wraps to two lines — see the stack below. --space-1
     rather than the column gap, so the name and its readings still read as ONE row and not
     as two rows that happen to be adjacent. */
  gap: var(--space-1) var(--wprow-gap, var(--space-2));
}
/* One icon-button's box, aligned to the start of the kind column, so the tent lands on the
   same pixel as the first toggle's glyph in the rows above it. */
.plan__campkind {
  grid-area: kind;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* the same box a kind toggle wears, whichever pointer is in use, so the tent's glyph
     lands on the pixel the first toggle's glyph lands on in the rows above */
  width: var(--wprow-btn, var(--icon-btn, 32px));
  /* ink, not a category hue — it is the itinerary talking, the same thing the handle on
     the map says by being paper-filled rather than solid */
  color: var(--ink-3);
}
.plan__campfield {
  min-width: 0;
  grid-area: name;
}
/* Lifted wholesale from .catbar__legend, deliberately: "the same treatment" means the same
   spacing and the same hanging indent, not something that merely resembles it. */
.daykey {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
  margin-top: var(--space-3);
  list-style: none;
  padding: 0;
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
/* The .swatch atom sets a size but not a DISPLAY, and a bare span is inline — where width
   and height do nothing at all, so the dot rendered at zero. CategoryBar carries this same
   pair in its own file; the vertical-align is its reasoning too, and it is a length rather
   than `middle` so the dot centres on the label's cap box instead of sitting ~1.4px low. */
.daykey .swatch {
  display: inline-block;
  vertical-align: 0.04em;
  margin-inline-end: var(--space-2);
}
/* the delete column, standing empty — see the template. It still has to hold the column
   open, and at the width a button would be, or every cell before it shifts on this row. */
.plan__campdel {
  grid-area: del;
  width: var(--wprow-btn, var(--icon-btn, 32px));
}
/* One size and one ink, matching a waypoint row's two readings exactly — see WaypointRow.
   Both cells answer the same question, so ranking one above the other with size or colour
   only breaks the baseline the column is read down. */
.plan__coord,
.plan__campdist {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
  color: var(--ink-3);
}
.plan__coord {
  grid-area: coord;
  /* stretched on one line, where text-align does the aligning; shrunk to its text and
     pushed left once the row wraps, so the two readings sit at opposite ends */
  justify-self: var(--wprow-coord-justify, stretch);
}
.plan__campdist {
  grid-area: dist;
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
  --wprow-btn: var(--icon-btn, 32px);
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
  list-style: none;
  margin: 0;
  padding: 0;
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
  margin: 0;
  padding-block: var(--space-1);
  line-height: 1.5;
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  /* a step back from a day's heading: this names the ground left over, not a plan */
  color: var(--ink-3);
}
</style>
