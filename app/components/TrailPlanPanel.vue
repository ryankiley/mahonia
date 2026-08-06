<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { ListSnapshot, Totals } from "~~/shared/types";
import { burnDownMg } from "~~/shared/tripPlan";
import { isWaterName } from "~~/shared/water";
import { lineMg, effectiveClassification, formatWeight } from "~~/shared/weights";
import { formatDistance, parseDistanceM, resolveDistanceUnit } from "~~/shared/trailDistance";
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

const days = computed(() => [...(props.snapshot.days ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
const distanceUnit = computed(() =>
  resolveDistanceUnit(props.snapshot.trailDistanceUnit, props.snapshot.displayUnit),
);

// What the dates say, against what the itinerary says. These are two different claims and
// the panel reports the disagreement rather than quietly reconciling it — silently
// trusting one would make the other field look broken.
const datedDays = computed(() => tripDays(props.snapshot.startDate, props.snapshot.endDate));
const dayCountMismatch = computed(
  () => datedDays.value != null && days.value.length > 0 && datedDays.value !== days.value.length,
);

const totalDistanceM = computed(() => days.value.reduce((s, d) => s + (d.distanceM ?? 0), 0));
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
const totalAscentM = computed(() => days.value.reduce((s, d) => s + (d.ascentM ?? 0), 0));

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

function commitDistance(id: string, e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim();
  c.updateDay(id, { distanceM: raw ? (parseDistanceM(raw, distanceUnit.value) ?? undefined) : undefined });
}
function commitAscent(id: string, e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim();
  // Ascent is a HEIGHT, so it reads in metres or feet — never in the km/mi the distance
  // beside it uses. Same parser; the fallback unit is what differs.
  c.updateDay(id, { ascentM: raw ? (parseDistanceM(raw, distanceUnit.value === "mi" ? "ft" : "m") ?? undefined) : undefined });
}
function commitLabel(id: string, e: Event) {
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
      <AnimatedCount class="t-num plan__big" :value="headlineValue" />
      <span class="plan__unit-lg" aria-hidden="true">{{ distanceUnit }}</span>
    </div>
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

    <p v-if="dayCountMismatch" class="plan__note t-sm">
      Your dates cover {{ datedDays }} {{ datedDays === 1 ? "day" : "days" }}, and there
      {{ days.length === 1 ? "is" : "are" }} {{ days.length }} here.
    </p>

    <!-- Empty state names what's missing rather than showing an empty table. -->
    <p v-if="!days.length" class="plan__note t-sm">
      Break the trip into days to see what each one asks of you, and what the pack weighs
      when you shoulder it that morning.
    </p>

    <ol v-else class="plan__days">
      <li v-for="(d, i) in days" :key="d.id" class="plan__day">
        <span class="plan__n t-label">Day {{ i + 1 }}</span>
        <input
          class="plan__label"
          :value="d.label ?? ''"
          :placeholder="`Day ${i + 1}`"
          :aria-label="`Name for day ${i + 1}`"
          @change="commitLabel(d.id, $event)"
        />
        <span class="plan__field">
          <input
            class="plan__num"
            inputmode="decimal"
            :value="distanceValue(d.distanceM)"
            :aria-label="`Distance on day ${i + 1}, in ${distanceUnit}`"
            placeholder="—"
            @change="commitDistance(d.id, $event)"
          />
          <span class="t-muted plan__unit">{{ distanceUnit }}</span>
        </span>
        <span class="plan__field">
          <input
            class="plan__num"
            inputmode="decimal"
            :value="ascentValue(d.ascentM)"
            :aria-label="`Climb on day ${i + 1}, in ${ascentUnit}`"
            placeholder="—"
            @change="commitAscent(d.id, $event)"
          />
          <span class="t-muted plan__unit">{{ ascentUnit }}</span>
        </span>

        <!-- The burn-down. One bar per day, NOT a line: a line would draw a segment
             between two days and so assert the pack's weight at noon, which nothing here
             knows. Read down the column it is the curve, with no invented point.
             aria-hidden because the figure is already text beside it — a role="img" here
             would make a screen reader say the same number twice. -->
        <span class="plan__pack">
          <span class="plan__bar" aria-hidden="true">
            <span class="plan__barfill" :style="{ width: `${(packMg[i]! / heaviestMg) * 100}%` }" />
          </span>
          <span class="t-num plan__packnum">{{ formatWeight(packMg[i] ?? 0, snapshot.displayUnit) }}</span>
        </span>

        <button
          type="button"
          class="btn btn--quiet plan__remove"
          :aria-label="`Remove day ${i + 1}`"
          @click="c.removeDay(d.id)"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="1.5" aria-hidden="true" />
        </button>
      </li>
    </ol>

    <button type="button" class="plan__add" @click="c.addDay()">
      <HugeiconsIcon :icon="PlusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
      Add a day
    </button>
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
.plan__unit-lg {
  color: var(--ink-3);
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
  gap: var(--space-2);
}
/* The row echoes an item row's shape — a 1fr name and fixed data tracks — so the two
   read as the same kind of object seen from a different angle. */
.plan__day {
  display: grid;
  grid-template-columns: auto 1fr 5.5rem 5.5rem 9rem var(--icon-btn);
  align-items: center;
  gap: var(--space-2);
}
.plan__n {
  white-space: nowrap;
}
.plan__label,
.plan__num {
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--radius-2);
  background: var(--paper-2);
  color: inherit;
  font: inherit;
}
.plan__num {
  width: 100%;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.plan__field {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
}
.plan__unit {
  flex: none;
}
.plan__pack {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
/* the CategoryBar idiom, at row scale — a rail and a proportional fill, no new vocabulary */
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
.plan__remove {
  color: var(--ink-3);
}
.plan__add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-3);
  cursor: pointer;
  font: inherit;
  transition: color var(--dur) var(--ease);
}
.plan__add:hover {
  color: var(--ink);
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
