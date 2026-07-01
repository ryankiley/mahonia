<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { UNITS } from "~~/shared/types";
import type { ListSnapshot, Totals, Unit } from "~~/shared/types";
import { formatWeight } from "~~/shared/weights";

const props = defineProps<{
  list: ListSnapshot;
  totals: Totals;
}>();

const emit = defineEmits<{
  "set-unit": [Unit];
}>();

// the classification breakdown chips, in fixed order; only categories that carry
// weight show (no "Consumable 0 g" noise)
const chips = computed(() =>
  [
    { label: "Base", mg: props.totals.baseMg },
    { label: "Worn", mg: props.totals.wornMg },
    { label: "Consumable", mg: props.totals.consumableMg },
  ].filter((c) => c.mg > 0),
);
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
            <ChevronDown class="totals__chev" :size="16" :stroke-width="2.25" />
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
  margin-top: var(--space-4);
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
</style>
