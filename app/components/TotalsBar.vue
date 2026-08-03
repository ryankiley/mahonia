<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";
import type { ListSnapshot, Totals, Unit } from "~~/shared/types";
import { UNITS } from "~~/shared/types";
import { carriedIsDistinct, formatKcal, formatWeight } from "~~/shared/weights";

const props = defineProps<{
  list: ListSnapshot;
  totals: Totals;
}>();

const emit = defineEmits<{
  "set-unit": [Unit];
}>();

// the classification breakdown chips, in fixed order; only categories that carry
// weight show (no "Consumable 0 g" noise)
const chips = computed(() => {
  const present = [
    { label: "Base", mg: props.totals.baseMg },
    { label: "Worn", mg: props.totals.wornMg },
    { label: "Consumable", mg: props.totals.consumableMg },
  ].filter((c) => c.mg > 0);
  // A lone "Base" chip equal to the total just restates the headline figure
  // directly beneath it — the same number twice, three times counting a
  // single-folder category bar. Base is the default class, so "it's all base" is
  // the null result and the big number already says it. Drop it.
  // A lone WORN or CONSUMABLE chip is kept: that one IS a fact about the pack the
  // headline doesn't carry (nothing here counts toward base weight), and nothing
  // else on the page states the classification.
  if (present.length === 1 && present[0]!.label === "Base") return [];
  return present;
});

// "Carried" — base + consumable, the weight actually on your back. The three chips
// above partition the total, so this is the one figure here that's a ROLL-UP of two of
// them rather than a slice, and it's the number you check against what a pack carries
// comfortably. LighterPack shows the slices and the skin-out total and leaves you to
// add two of them in your head.
//
// carriedIsDistinct (shared/weights.ts) decides whether it's worth showing — the same
// call the Markdown export makes, so the two can't drift.
const showCarried = computed(() => carriedIsDistinct(props.totals));

const kcalDisplay = computed(() => formatKcal(props.totals.kcalTotal));
</script>

<template>
  <div class="totals">
    <div class="totals__main">
      <div class="totals__headline">
        <!-- no "Total" label: the big figure makes it implicit. the figure starts
             zeroed (not a placeholder line) so nothing reflows when the first
             weighted item lands — the number just counts up. -->
        <div class="totals__amount">
          <AnimatedCount class="t-num totals__big" :value="formatWeight(totals.totalMg, list.displayUnit, { withUnit: false })" />
          <span class="totals__uc" aria-hidden="true">
            <span class="totals__unit">{{ list.displayUnit }}</span>
            <!-- stroke 2.25, not the app-wide 2: at size 16 it renders an exact
                 1.5px stroke (crisp 3 device px at 2x), so the chevron holds its
                 weight beside the display-size figure -->
            <HugeiconsIcon :icon="ChevronDownIcon" class="totals__chev" :size="16" :stroke-width="2.25" />
          </span>
          <!-- transparent native select over the number: tap the total to change units -->
          <select
            class="totals__unitsel"
            title="Change unit"
            aria-label="Weight unit"
            :value="list.displayUnit"
            @change="emit('set-unit', ($event.target as HTMLSelectElement).value as Unit)"
          >
            <option v-for="u in UNITS" :key="u" :value="u">{{ u }}</option>
          </select>
        </div>
      </div>
    </div>

    <!-- always rendered: the bar holds a blank rail at zero so it never reflows in.
         the chips stay per-category — they pop in as each class first gains weight -->
    <div class="totals__breakdown">
      <!-- only the categories actually present show — no "Consumable 0 g" noise -->
      <div class="totals__chips">
        <span v-for="c in chips" :key="c.label" class="chip">
          <span class="t-label">{{ c.label }}</span>
          <span class="t-num">{{ formatWeight(c.mg, list.displayUnit, { withUnit: false }) }} <span class="t-muted">{{ list.displayUnit }}</span></span>
        </span>
        <!-- the derived roll-up, set apart by a hairline because it doesn't belong to
             the partition on its left; the tooltip carries the definition so the label
             doesn't have to spell out the arithmetic -->
        <!-- opens DOWNWARD: the chips sit directly under the display-size total, and a
             top-anchored popup lands on top of the one number the page exists to show.
             Below it, it only crosses the category sparkline. Still flips back up near
             the viewport floor. -->
        <Tooltip
          v-if="showCarried"
          preferred-placement="bottom"
          text="Base + consumable — everything in the pack, nothing worn on your body."
        >
          <span class="chip chip--sum">
            <span class="t-label">Carried</span>
            <span class="t-num">{{ formatWeight(totals.carriedMg, list.displayUnit, { withUnit: false }) }} <span class="t-muted">{{ list.displayUnit }}</span></span>
          </span>
        </Tooltip>
        <!-- calories sit APART from the chips on their left: those three partition the
             weight, and this is a different quantity entirely — dropping it into the
             same row would read as a fourth slice of the total. Only appears once
             something carries a value (hasKcal), so the overwhelming majority of
             lists, which will never use it, never see it. -->
        <Tooltip
          v-if="totals.hasKcal"
          preferred-placement="bottom"
          text="Food energy across everything classed as consumable."
        >
          <span class="chip chip--alt">
            <span class="t-label">Calories</span>
            <span class="t-num">{{ kcalDisplay }} <span class="t-muted">kcal</span></span>
          </span>
        </Tooltip>
      </div>
      <CategoryBar :list="list" />
    </div>
  </div>
</template>

<style scoped>
.totals {
  padding-block: var(--space-2) var(--space-4);
}
.totals__main {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.totals__headline {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.totals__amount {
  position: relative;
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
}
.totals__big {
  font-size: var(--text-display);
  line-height: 0.95;
  letter-spacing: -0.02em;
  color: var(--accent);
}
/* unit + its dropdown chevron travel together, centered to each other, and the
   group baseline-aligns with the big figure */
.totals__uc {
  display: inline-flex;
  align-items: center;
  gap: var(--space-px);
}
.totals__unit {
  font-size: var(--text-title);
  font-weight: 400;
  color: var(--ink-2);
  /* half-step between the type system's two trackings: the full -0.02em tight
     visibly pinches a bare two-letter unit ("oz"), while normal tracking reads
     loose beside the tightly-tracked display figure */
  letter-spacing: -0.01em;
}
.totals__chev {
  flex: none;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.totals__amount:hover .totals__chev {
  color: var(--ink);
}
.totals__unitsel {
  position: absolute;
  inset: 0;
  width: 100%;
  border: 0;
  opacity: 0; /* invisible — the number + chevron are the visible affordance */
  cursor: pointer;
}
.totals__breakdown {
  /* one step up from --space-4 — the display-size figure above has a lot of optical
     mass, so the breakdown needs more clearance than a body-copy gap to stop reading
     as a caption hanging off the number */
  margin-top: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.totals__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
}
.chip {
  display: inline-flex;
  flex-direction: column;
  gap: var(--space-px);
}
/* the roll-up chip reads as a different KIND of figure from the slices beside it —
   a hairline + the row's own gap sets it apart without a heavy divider (same idiom
   as the ⋯ menu's report row). The gap is --space-5, so the rule sits optically
   centred in it rather than crowding the label. */
.chip--sum {
  padding-left: var(--space-5);
  border-left: 1px solid var(--line);
}
/* calories take the same hairline separation as the roll-up, for a related but
   distinct reason: --sum is a figure derived FROM the partition on its left, this
   one isn't in that partition at all. Either way it must not read as a fourth slice. */
.chip--alt {
  padding-left: var(--space-5);
  border-left: 1px solid var(--line);
}
</style>
