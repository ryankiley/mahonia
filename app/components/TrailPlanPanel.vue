<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowUpRight01Icon, ChevronDownIcon, Clock01Icon, Delete02Icon, Fire02Icon, HelpCircleIcon, RouteIcon } from "@hugeicons/core-free-icons";
import type { ListSnapshot, Totals } from "~~/shared/types";
import { burnDownMg, estimateDay } from "~~/shared/tripPlan";
import { parseProfile, segmentClimbs } from "~~/shared/gpx";
import { isWaterName } from "~~/shared/water";
import { lineMg, effectiveClassification, formatWeight } from "~~/shared/weights";
import {
  BODY_WEIGHT_UNITS,
  DEFAULT_BODY_G,
  DISPLAY_DISTANCE_UNITS,
  bodyWeightFieldValue,
  formatBodyWeight,
  formatDistance,
  parseBodyWeightG,
  parseDistanceM,
  resolveBodyWeightUnit,
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
 * `Math.max` rather than the dates alone: a trip can outgrow its dates, and an itinerary
 * someone actually built must never be truncated by a date field.
 */
const days = computed(() => {
  const dated = tripDays(props.snapshot.startDate, props.snapshot.endDate) ?? 0;
  const n = Math.max(stored.value.length, dated);
  return Array.from({ length: n }, (_, i) => stored.value[i] ?? null);
});

/** A ghost row becoming real. Returns the id to patch. */
function ensureDay(i: number): string | null {
  const existing = stored.value[i];
  if (existing) return existing.id;
  // fill any gap before it too, so sortOrder stays the position in the trip
  for (let k = stored.value.length; k <= i; k++) c.addDay();
  return null; // the patch lands on the next tick, once the op has applied
}
const distanceUnit = computed(() =>
  resolveDistanceUnit(props.snapshot.trailDistanceUnit, props.snapshot.displayUnit),
);

const totalDistanceM = computed(() => days.value.reduce((s, d) => s + (d?.distanceM ?? 0), 0));
// The days are the plan, so they're the source — but before any day is filled in, the
// route's own distance is the honest total, and it's already on the trail link. Falling
// back to it means the headline says something true from the first moment rather than
// sitting at zero until the itinerary is typed.
const headlineM = computed(() => totalDistanceM.value || props.snapshot.trailDistanceM || 0);
// The bare number; the unit sits beside it at caption size, as the weight headline does.
const headlineValue = computed(() =>
  formatDistance(headlineM.value, distanceUnit.value).replace(/\s*(km|mi|m)$/, ""),
);
const perDayDistance = computed(() =>
  headlineM.value > 0 && days.value.length > 0
    ? formatDistance(Math.round(headlineM.value / days.value.length), distanceUnit.value)
    : null,
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
// Optional, with a STATED default. `isDefault` is what keeps that honest: the control
// reads "assuming 70 kg" until someone sets one, rather than sitting pre-filled with 70,
// because a pre-filled field looks like something you already confirmed.
const bodyUnit = computed(() =>
  resolveBodyWeightUnit(props.snapshot.bodyWeightUnit, props.snapshot.displayUnit),
);
const bodyG = computed(() => props.snapshot.bodyWeightG ?? DEFAULT_BODY_G);
const bodyIsDefault = computed(() => props.snapshot.bodyWeightG == null);
const bodyFieldValue = computed(() =>
  props.snapshot.bodyWeightG ? bodyWeightFieldValue(props.snapshot.bodyWeightG, bodyUnit.value) : "",
);
function commitBody(e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim();
  c.setMeta({ bodyWeightG: raw ? (parseBodyWeightG(raw, bodyUnit.value) ?? "") : "" });
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
          descentM: d.descentM,
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
// Each day's share of the ground, for cutting the profile into coloured stretches. A day
// with no distance yet still takes an even slice, so the picture doesn't lurch as the
// itinerary is filled in.
const dayDistancesM = computed(() => {
  const stated = days.value.map((d) => d?.distanceM ?? 0);
  const total = stated.reduce((s, d) => s + d, 0);
  if (total > 0) return stated;
  const each = headlineM.value / Math.max(1, days.value.length);
  return days.value.map(() => each);
});

const UNIT_OPTIONS = DISPLAY_DISTANCE_UNITS.map((u) => ({ key: u, label: u }));

/**
 * What a day is CALLED when you haven't named it — "Monday, Day 2" once the trip has
 * dates, "Day 2" before that.
 *
 * The weekday is the thing people actually plan against ("the big climb is Tuesday"), and
 * the app already knows it: the count comes from the dates, so day i IS start + i.
 *
 * Parsed at T00:00:00Z and read back in UTC, matching how the dates are stored — a
 * local-midnight Date would name the wrong weekday for anyone west of UTC.
 */
function dayOrdinal(i: number): string {
  const n = `Day ${i + 1}`;
  const start = props.snapshot.startDate;
  if (!start) return n;
  const ms = Date.parse(`${start}T00:00:00Z`);
  if (Number.isNaN(ms)) return n;
  const weekday = new Date(ms + i * 86_400_000).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  return `${weekday}, ${n}`;
}
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
const derivedClimbs = computed(() => {
  if (!profile.value.length) return [];
  const parts = segmentClimbs(profile.value, dayDistancesM.value);
  const fromProfile = parts.reduce((s, x) => s + x.ascentM, 0);
  const trueTotal = props.snapshot.trailAscentM;
  // SHAPE from the profile, MAGNITUDE from the full track. 96 samples is plenty to draw
  // with and far too coarse to measure with — measured off the profile alone, a real
  // 3,123 m loop reads about 1,600, because resampling smooths away half the undulation.
  // Proportions survive that; totals don't. Without a stored total (a profile from an
  // older list) the shares stand as they are rather than being invented.
  if (!trueTotal || !(fromProfile > 0)) return parts;
  const scale = trueTotal / fromProfile;
  return parts.map((x) => ({
    ascentM: Math.round(x.ascentM * scale),
    descentM: Math.round(x.descentM * scale),
  }));
});
const climbFor = (i: number) => days.value[i]?.ascentM ?? derivedClimbs.value[i]?.ascentM;
const climbIsDerived = (i: number) =>
  days.value[i]?.ascentM == null && derivedClimbs.value[i]?.ascentM != null;

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
async function commitLabel(id: string | null, e: Event) {
  if (!id) { await nextTick(); id = stored.value[stored.value.length - 1]?.id ?? null; if (!id) return; }
  c.updateDay(id, { label: (e.target as HTMLInputElement).value.trim() });
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
        title="Change unit"
        @pick="(u) => c.setMeta({ trailDistanceUnit: u })"
      >
        <template #trigger="{ open }">
          <AnimatedCount class="t-num plan__big" :value="headlineValue" />
          <span class="plan__uc" aria-hidden="true">
            <span class="plan__unit-lg">{{ distanceUnit }}</span>
            <HugeiconsIcon :icon="ChevronDownIcon" class="plan__chev" :class="{ 'is-open': open }" :size="16" :stroke-width="2.25" />
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
    />
    <p v-if="perDayDistance" class="plan__perday t-sm">
      {{ perDayDistance }} a day across {{ days.length }} {{ days.length === 1 ? "day" : "days" }}
    </p>

    <div class="plan__chips">
      <span class="chip">
        <span class="t-label">Days</span>
        <span class="t-num">{{ days.length }}</span>
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
    </div>

    <!-- Empty state names what's missing rather than showing an empty table. -->
    <p v-if="!days.length" class="plan__note t-sm">
      Break the trip into days to see what each one asks of you, and what the pack weighs
      when you shoulder it that morning.
    </p>

    <ol v-else class="plan__days">
      <li v-for="(d, i) in days" :key="d?.id ?? `ghost-${i}`" class="plan__day">
        <!-- The heading takes the FOLDER treatment — a day groups a stretch of the walk
             the way a folder groups gear, so it reads at the same level and gets the same
             editable-name affordance. -->
        <header class="plan__dayhead">
          <!-- Unnamed, the placeholder IS the name — "Day 3" and nothing else, because a
               number is what an unnamed day is called. Name it and the ordinal doesn't
               leave; it steps back and follows, so the position in the trip is never lost
               to a name. ONE type size throughout: only the colour changes, so a rename
               doesn't reflow the row. -->
          <input
            class="field plan__name"
            :value="d?.label ?? ''"
            :placeholder="dayOrdinal(i)"
            :aria-label="`Name for day ${i + 1}`"
            :size="Math.max(6, (d?.label || dayOrdinal(i)).length)"
            autocorrect="off"
            spellcheck="false"
            @change="commitLabel(d?.id ?? ensureDay(i), $event)"
          />
          <span v-if="d?.label" class="plan__ordinal" aria-hidden="true">{{ dayOrdinal(i) }}</span>
          <button
            type="button"
            class="plan__collapse plan__collapse--tight"
            :aria-expanded="!collapsed[d?.id ?? '']"
            :aria-label="`${collapsed[d?.id ?? ''] ? 'Expand' : 'Collapse'} ${d?.label || `day ${i + 1}`}`"
            @click="d && toggleDay(d.id)"
          >
            <HugeiconsIcon :icon="ChevronDownIcon" class="plan__chev2" :class="{ 'is-collapsed': collapsed[d?.id ?? ''] }" :size="20" :stroke-width="2" />
          </button>
          <button
            type="button"
            class="btn btn--icon btn--ghost plan__del plan__del--end"
            :title="`Remove day ${i + 1}`"
            :aria-label="`Remove day ${i + 1}`"
            @click="d && c.removeDay(d.id)"
          >
            <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="1.5" />
          </button>
        </header>

        <!-- The data reads as one line of glyph-and-figure pairs, the way an item row
             does: what you TYPE first, then what follows from it. -->
        <div v-if="!collapsed[d?.id ?? '']" class="plan__data">
          <span class="plan__cell">
            <HugeiconsIcon :icon="RouteIcon" class="plan__gl" :size="14" :stroke-width="2" aria-hidden="true" />
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
            <HugeiconsIcon :icon="ArrowUpRight01Icon" class="plan__gl" :size="14" :stroke-width="2" aria-hidden="true" />
            <input
              class="field field--num plan__num"
              inputmode="decimal"
              :value="ascentValue(climbFor(i))"
              :aria-label="`Climb on day ${i + 1}, in ${ascentUnit}`"
              :placeholder="profile.length ? '—' : '—'"
              @change="commitAscent(d?.id ?? ensureDay(i), $event)"
            />
            <span class="t-muted">{{ ascentUnit }}</span>
            <Tooltip v-if="climbIsDerived(i)" text="Read off the GPX — this day's share of the route's climb. Type over it to set your own." preferred-placement="top">
              <button type="button" class="plan__why" aria-label="Where this climb comes from">
                <HugeiconsIcon :icon="HelpCircleIcon" :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
            </Tooltip>
          </span>

          <!-- Read-only, and worked out rather than measured — so it carries the `~` AND
               a (?) you can actually reach. A bare title= is invisible to a phone and to
               a keyboard; Tooltip is the app's own affordance and answers both. -->
          <span class="plan__cell plan__cell--est">
            <HugeiconsIcon :icon="Clock01Icon" class="plan__gl" :size="14" :stroke-width="2" aria-hidden="true" />
            <span class="t-num">{{ estimates[i] ? `~${formatHours(estimates[i]!.hours)}` : "—" }}</span>
            <Tooltip v-if="estimates[i]" text="Moving time, from this day's own distance and climb plus 1% per kg of pack. Breaks aren't in it." preferred-placement="top">
              <button type="button" class="plan__why" aria-label="How the moving time is worked out">
                <HugeiconsIcon :icon="HelpCircleIcon" :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
            </Tooltip>
          </span>

          <span class="plan__cell plan__cell--est">
            <HugeiconsIcon :icon="Fire02Icon" class="plan__gl" :size="14" :stroke-width="2" aria-hidden="true" />
            <span class="t-num">{{ estimates[i] ? `~${roundKcal(estimates[i]!.totalKcal).toLocaleString()}` : "—" }}</span>
            <Tooltip v-if="estimates[i]" :text="`Walking and resting for the day, at ${formatBodyWeight(bodyG, bodyUnit)}${bodyIsDefault ? ' — assumed, set yours below' : ''}. Good to about ±20%.`" preferred-placement="top">
              <button type="button" class="plan__why" aria-label="How the calories are worked out">
                <HugeiconsIcon :icon="HelpCircleIcon" :size="13" :stroke-width="2" aria-hidden="true" />
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

    <p v-if="tripHours > 0" class="plan__est-total t-sm">
      About <strong class="t-num">~{{ formatHours(tripHours) }}</strong> moving and
      <strong class="t-num">~{{ roundKcal(tripKcal).toLocaleString() }} kcal</strong> over the trip.
    </p>

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
             only, absent follows the list's weight unit, the stored grams never move).
             A body in ounces is not a thing anyone wants to read. -->
        <OptionMenu
          :options="BODY_UNIT_OPTIONS"
          :current="bodyUnit"
          label="Body weight unit"
          title="Change unit"
          @pick="(u) => c.setMeta({ bodyWeightUnit: u })"
        >
          <template #trigger="{ open }">
            <span class="t-muted">{{ bodyUnit }}</span>
            <HugeiconsIcon :icon="ChevronDownIcon" class="plan__chev" :class="{ 'is-open': open }" :size="12" :stroke-width="2" />
          </template>
        </OptionMenu>
      </span>
      <span v-if="bodyIsDefault" class="plan__assumed">assumed</span>
    </p>
    <!-- One line, not a paragraph. The `~` on each figure is what carries the claim;
         this only says what the mark means, once. The detail lives in the (?) beside the
         figures, where it's asked for rather than recited. -->
    <p v-if="tripHours > 0" class="plan__accuracy t-sm">~ worked out, not measured — about ±20%.</p>

    <div class="plan__addwrap">
      <button type="button" class="plan__add" @click="c.addDay()">Add a day</button>
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
.plan__unit-lg {
  color: var(--ink-3);
}
.plan__chev {
  align-self: center;
  transition: transform var(--dur) var(--ease);
}
.plan__chev.is-open {
  transform: rotate(180deg);
}
.plan__perday {
  margin: calc(var(--space-2) * -1) 0 0;
  color: var(--ink-3);
}
.plan__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
}
/* The totals bar's chip shape, restated. `.chip` is scoped to that component, so this
   can't borrow it — and shouldn't reach across the boundary to try. Same geometry, so a
   figure reads the same wherever it appears; if the two ever need to move together they
   belong in an atom, which is a bigger change than this panel should make. */
.plan__chips .chip {
  display: inline-flex;
  flex-direction: column;
  gap: var(--space-px);
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
/* A day is a folder-shaped thing: a name you can edit at title size, its own actions,
   then its contents underneath. Same rhythm, so the two read as siblings. */
.plan__dayhead {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.plan__n {
  flex: none;
  color: var(--ink-3);
}
.plan__name {
  flex: 0 1 auto;
  /* .field is width:100%, which would push the chevron to the far edge and detach it from
     the name it folds. Size to the CONTENT instead, the way the title does — the native
     property where it exists, with a modest fallback width elsewhere so the field is
     still comfortably clickable when it's empty and showing only "Day 3". */
  width: auto;
  field-sizing: content;
  max-width: min(40ch, 50vw);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0;
  border: 0;
  background: none;
  font-family: var(--font);
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
.plan__data {
  margin-top: var(--space-2);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
}
.plan__cell {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-2);
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
  color: var(--ink-ghost);
  cursor: help;
  transition: color var(--dur) var(--ease);
}
.plan__why:hover,
.plan__why:focus-visible {
  color: var(--ink-3);
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
/* the ordinal follows a named day at the SAME size — only the colour steps back, so
   naming a day never reflows its row */
.plan__ordinal {
  flex: none;
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  color: var(--ink-ghost);
}
.plan__gl {
  flex: none;
  color: var(--ink-3);
}
/* .field + .field--num carry the shape (uncontained, no fill, caret-as-focus, the
   tabular numerals and the iOS 16px rule) — an item row's weight box and this are the
   same object, so they are the same atom. Only the width is local: a day's figures are
   short, and .field is width:100%. */
.plan__num {
  width: 3.25rem;
  min-width: 0;
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
/* the "Add folder" treatment: title-sized, dimmed, inks up on hover */
.plan__addwrap {
  align-self: flex-start;
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
  color: var(--ink-ghost);
  transition: color var(--dur) var(--ease);
}
.plan__add:hover {
  color: var(--ink-3);
}
.plan__est-total {
  margin: 0;
  color: var(--ink-2);
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
.plan__packnum {
  flex: none;
  font-variant-numeric: tabular-nums;
}
/* On a phone the six-track grid can't hold; the row becomes two lines with the
   measurements sharing the second, which is the same concession an item row makes. */
@media (max-width: $bp-stack) {
  .plan__day {
    grid-template-columns: auto 1fr var(--icon-btn);
    row-gap: var(--space-1);
  }
  .plan__field {
    grid-column: 2 / 3;
  }
  .plan__pack {
    grid-column: 2 / 4;
  }
}
</style>
