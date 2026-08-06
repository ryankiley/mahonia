<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowDownRight01Icon, ArrowUpRight01Icon, ChevronDownIcon, Clock01Icon, Delete02Icon, Fire02Icon, HelpCircleIcon, RouteIcon } from "@hugeicons/core-free-icons";
import type { ListSnapshot, Totals } from "~~/shared/types";
import { burnDownMg, estimateDay } from "~~/shared/tripPlan";
import { dayClimbs, parseProfile } from "~~/shared/gpx";
import { MAX_DAYS } from "~~/shared/ops";
import { dayLabel } from "~~/shared/tripDay";
import { isWaterName } from "~~/shared/water";
import { lineMg, effectiveClassification, formatWeight } from "~~/shared/weights";
import type { BodyWeightUnit } from "~~/shared/trailDistance";
import {
  BODY_WEIGHT_UNITS,
  DEFAULT_BODY_G,
  DISPLAY_DISTANCE_UNITS,
  bodyWeightFieldValue,
  formatBodyWeight,
  distanceHeadline,
  formatDistance,
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
const distanceUnit = computed(() =>
  resolveDistanceUnit(props.snapshot.trailDistanceUnit, props.snapshot.displayUnit),
);

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
const headlineM = computed(() =>
  Math.max(props.snapshot.trailDistanceM ?? 0, totalDistanceM.value),
);
// The bare number; the unit sits beside it at caption size, as the weight headline does.
//
// distanceHeadline, NOT formatDistance-and-strip-the-unit. formatDistance drops to metres
// below a kilometre, so stripping a trailing unit off it left a bare "800" standing next
// to a picker still reading "km" — an 800-metre walk shown as 800 kilometres. The unit
// here is a control the reader chose, so the number has to stay in it.
const headlineValue = computed(() => distanceHeadline(headlineM.value, distanceUnit.value));
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
  m == null ? "" : (distanceUnit.value === "mi" ? Math.round(m / 0.3048) : Math.round(m)).toLocaleString();

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

/** The pack at the middle of each day, heaviest first. */
const packMg = computed(() => burnDownMg(props.totals.carriedMg, burnableMg.value, days.value.length));
// One denominator down the whole column, so the bars are comparable to each other rather
// than each row being its own 100% — the mistake that would make a burn-down look flat.
const heaviestMg = computed(() => Math.max(1, ...packMg.value));

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
/** "4 h 20" — hours and minutes, never a decimal. Nobody walks for 4.33 hours. */
function formatHours(h: number): string {
  const mins = Math.round(h * 60);
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return hh ? `${hh} h ${String(mm).padStart(2, "0")}` : `${mm} min`;
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

const UNIT_OPTIONS = DISPLAY_DISTANCE_UNITS.map((u) => ({ key: u, label: u }));

// Naming a day lives in shared/tripDay.ts — a shared list shows the itinerary too, and
// the two views must agree on what a day is called.
const dayOrdinal = (i: number) => dayLabel(i, props.snapshot.startDate);

const BODY_UNIT_OPTIONS = BODY_WEIGHT_UNITS.map((u) => ({ key: u, label: u }));

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
  days.value[i]?.ascentM ??
  (days.value[i]?.distanceM != null ? derivedClimbs.value[i]?.ascentM : undefined);
const climbIsDerived = (i: number) => days.value[i]?.ascentM == null && climbFor(i) != null;
// The matching descent. Nothing in the app writes TripDay.descentM — there is no field
// for it — so without this every day fell back to estimateDay's default of "descends
// exactly what it climbs", while the real figure sat unused in derivedClimbs one line
// above. On a route that ends lower than it starts, that default is simply wrong.
const descentFor = (i: number) =>
  days.value[i]?.descentM ??
  (days.value[i]?.distanceM != null ? derivedClimbs.value[i]?.descentM : undefined);

async function commitDistance(id: string | null, e: Event) {
  if (!id) { await nextTick(); id = stored.value[stored.value.length - 1]?.id ?? null; if (!id) return; }
  const raw = (e.target as HTMLInputElement).value.trim();
  c.updateDay(id, { distanceM: raw ? (parseDistanceM(raw, distanceUnit.value) ?? undefined) : undefined });
}
async function commitAscent(id: string | null, e: Event) {
  if (!id) { await nextTick(); id = stored.value[stored.value.length - 1]?.id ?? null; if (!id) return; }
  const raw = (e.target as HTMLInputElement).value.trim();
  // Ascent is a HEIGHT, so it reads in metres or feet — never in the km/mi the distance
  // beside it uses. Same parser; the fallback unit is what differs.
  c.updateDay(id, { ascentM: raw ? (parseDistanceM(raw, distanceUnit.value === "mi" ? "ft" : "m") ?? undefined) : undefined });
}

const ascentUnit = computed(() => (distanceUnit.value === "mi" ? "ft" : "m"));
// Metres round-trip exactly; FEET don't, because the store is integer metres — type 690
// and it comes back 689. Rounding display feet to the nearest 10 hides an artefact that
// isn't a real disagreement, and it's the more honest figure besides: consumer elevation
// is noisy to ±5–10 m, so a climb quoted to the foot claims precision nothing has.
const ascentValue = (m: number | undefined) => {
  if (m == null) return "";
  if (distanceUnit.value !== "mi") return String(Math.round(m));
  return String(Math.round(m / 0.3048 / 10) * 10);
};
const distanceValue = (m: number | undefined) =>
  m == null ? "" : String(Number((m / (distanceUnit.value === "mi" ? 1609.344 : 1000)).toFixed(2)));
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
    <div class="plan__headline">
      <!-- The unit is a PICKER here, as it is on the weight headline in the other two
           views — the same gesture in the same place, so changing mode changes the number
           rather than what you can do to it. -->
      <OptionMenu
        class="plan__amount"
        align="baseline"
        :options="UNIT_OPTIONS"
        :current="distanceUnit"
        label="Distance unit"
        :trigger-label="`${headlineValue} ${distanceUnit}, change distance unit`"
        title="Change unit"
        @pick="(u) => c.setMeta({ trailDistanceUnit: u })"
      >
        <template #trigger="{ open }">
          <AnimatedCount class="t-num plan__big" :value="headlineValue" />
          <span class="plan__uc" aria-hidden="true">
            <span class="plan__unit-lg">{{ distanceUnit }}</span>
            <HugeiconsIcon :icon="ChevronDownIcon" class="plan__chev" :class="{ 'is-open': open }" :size="20" :stroke-width="2" />
          </span>
        </template>
      </OptionMenu>
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
    />
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
        <span class="t-num">{{ formatWeight(totals.carriedMg, snapshot.displayUnit) }}</span>
      </span>
      <!-- The trip's own estimates, up here with the facts they're derived from rather
           than in a sentence at the foot. They keep the `~` and step back in colour: the
           chips to their left are measured, these are worked out. -->
      <span v-if="tripHours > 0" class="chip chip--est">
        <span class="t-label">Moving</span>
        <span class="t-num">~{{ formatHours(tripHours) }}</span>
      </span>
      <span v-if="tripHours > 0" class="chip chip--est">
        <span class="t-label">Burn</span>
        <span class="t-num">~{{ roundKcal(tripKcal).toLocaleString() }} <span class="t-muted">kcal</span></span>
      </span>
    </div>

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
              @change="commitDistance(d?.id ?? ensureDay(i), $event)"
            />
            <span class="t-muted">{{ distanceUnit }}</span>
          </span>

          <!-- Climb comes off the GPX when there is one, and is muted to say so. Typing
               over it makes it yours, and the value stops being derived. -->
          <span class="plan__cell" :class="{ 'is-derived': climbIsDerived(i) }">
            <HugeiconsIcon :icon="ArrowUpRight01Icon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <input
              class="field field--num plan__num"
              inputmode="decimal"
              :value="ascentValue(climbFor(i))"
              :aria-label="`Elevation gain on day ${i + 1}, in ${ascentUnit}`"
              placeholder="—"
              @change="commitAscent(d?.id ?? ensureDay(i), $event)"
            />
            <span class="t-muted">{{ ascentUnit }}</span>
            <Tooltip v-if="climbIsDerived(i)" text="This day's share of the route's climb. Type over it to set your own." preferred-placement="top">
              <button type="button" class="plan__why" aria-label="Where this climb comes from">
                <HugeiconsIcon :icon="HelpCircleIcon" :size="14" :stroke-width="2" aria-hidden="true" />
              </button>
            </Tooltip>
          </span>

          <!-- The day's DROP, read off the route beside its climb. Not typeable, unlike the
               two above: nothing in the app writes a day's descent by hand, and a field
               that only ever shows a derived number should look like what it is. -->
          <span v-if="descentFor(i) != null" class="plan__cell plan__cell--est">
            <HugeiconsIcon :icon="ArrowDownRight01Icon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <span class="t-num">{{ ascentValue(descentFor(i)) }} <span class="t-muted">{{ ascentUnit }}</span></span>
          </span>

          <!-- Read-only, and worked out rather than measured — so it carries the `~` AND
               a (?) you can actually reach. A bare title= is invisible to a phone and to
               a keyboard; Tooltip is the app's own affordance and answers both. -->
          <span class="plan__cell plan__cell--est">
            <HugeiconsIcon :icon="Clock01Icon" class="plan__gl" :size="16" :stroke-width="2" aria-hidden="true" />
            <span class="t-num">{{ estimates[i] ? `~${formatHours(estimates[i]!.hours)}` : "—" }}</span>
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

          <!-- The pack that morning. One bar per day, NOT a line: a line would assert the
               weight at noon, which nothing here knows. Read down the column it is the
               curve, with no invented point. aria-hidden because the figure is text
               beside it, and a role="img" would say the number twice. -->
          <span class="plan__pack">
            <span class="plan__bar" aria-hidden="true">
              <span class="plan__barfill" :style="{ width: `${(packMg[i]! / heaviestMg) * 100}%` }" />
            </span>
            <span class="t-num plan__packnum">{{ formatWeight(packMg[i] ?? 0, snapshot.displayUnit) }}</span>
          </span>
        </div>
      </li>
    </ol>

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
          :options="BODY_UNIT_OPTIONS"
          :current="bodyUnit"
          label="Body weight unit"
          title="Change unit"
          @pick="(u) => body.setUnit(u as BodyWeightUnit)"
        >
          <template #trigger="{ open }">
            <span class="t-muted">{{ bodyUnit }}</span>
            <HugeiconsIcon :icon="ChevronDownIcon" class="plan__chev" :class="{ 'is-open': open }" :size="12" :stroke-width="2" />
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
  padding-block: var(--space-4);
}
/* The weight headline's geometry, so the two views' big figures sit in the same place
   and switching mode swaps the number rather than moving it. */
.plan__headline {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.plan__big {
  font-size: var(--text-display);
  line-height: 0.95;
  letter-spacing: var(--track-tight);
}
.plan__amount {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
}
.plan__uc {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-px);
  color: var(--ink-3);
}
/* the unit reads at the folder-name size with the folder's chevron beside it, rather
   than the caption scale the weight headline uses — a unit you can CHANGE should look
   like the other things you can change, and 20/2 is the chevron every folder carries */
.plan__unit-lg {
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  color: var(--ink-3);
}
.plan__chev {
  align-self: center;
  transition: transform var(--dur) var(--ease);
}
.plan__chev.is-open {
  transform: rotate(180deg);
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
  margin: 0;
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
  /* .field pads its box for a comfortable tap target; inside a glyph-and-figure pair
     that padding reads as a stray gap, and the cell's own gap already spaces them */
  --field-pad-inline: 0;
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
.plan__pack {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 8rem;
  flex: 1;
}
.plan__bar {
  flex: 1;
  min-width: var(--bar-seg-min);
  height: var(--bar-h);
  border-radius: var(--radius-pill);
  background: var(--paper-3);
  overflow: hidden;
}
.plan__barfill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--cat-consumable);
}
.plan__packnum {
  flex: none;
  font-variant-numeric: tabular-nums;
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
/* an estimate chip reads a step back from the measured ones beside it */
.plan__chips .chip--est {
  color: var(--ink-3);
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
</style>
