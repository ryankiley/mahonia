<script setup lang="ts">
import { Backpack, ChevronDown, PersonStanding, Utensils } from "@lucide/vue";
import type { ListSnapshot, Totals, Unit } from "~~/shared/types";
import { formatWeight } from "~~/shared/weights";

const props = withDefaults(
  defineProps<{
    list: ListSnapshot;
    totals: Totals;
    packed?: boolean;
    readonly?: boolean; // read-only share view: hide the Packing toggle, keep the unit switch
  }>(),
  { packed: false, readonly: false },
);

const emit = defineEmits<{
  "update:packed": [boolean];
  "set-unit": [Unit];
}>();

const UNITS: Unit[] = ["g", "kg", "oz", "lb"];
</script>

<template>
  <div class="totals">
    <div class="totals__main">
      <div class="totals__headline">
        <!-- no "Total" label: the big figure makes it implicit -->
        <div v-if="totals.hasWeights" class="totals__amount">
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
        <span v-else class="t-muted totals__empty">Add weights to see your pack weight</span>
      </div>

      <div v-if="!readonly" class="totals__controls">
        <button class="btn btn--sm" :aria-pressed="packed" @click="emit('update:packed', !packed)">
          {{ packed ? "Editing" : "Packing" }}
        </button>
      </div>
    </div>

    <!-- the breakdown is always shown once any weights exist -->
    <div v-if="totals.hasWeights" class="totals__breakdown">
      <div class="totals__chips">
        <span class="chip">
          <span class="chip__head"><Backpack class="chip__icon" :size="14" :stroke-width="2" aria-hidden="true" /><span class="t-label">Base</span></span>
          <span class="t-num">{{ formatWeight(totals.baseMg, list.displayUnit) }}</span>
        </span>
        <span class="chip">
          <span class="chip__head"><PersonStanding class="chip__icon" :size="14" :stroke-width="2" aria-hidden="true" /><span class="t-label">Worn</span></span>
          <span class="t-num">{{ formatWeight(totals.wornMg, list.displayUnit) }}</span>
        </span>
        <span class="chip">
          <span class="chip__head"><Utensils class="chip__icon" :size="14" :stroke-width="2" aria-hidden="true" /><span class="t-label">Consumable</span></span>
          <span class="t-num">{{ formatWeight(totals.consumableMg, list.displayUnit) }}</span>
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
  gap: var(--space-1);
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
.totals__empty {
  font-size: var(--text-base);
}
.totals__controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
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
.chip__head {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.chip__icon {
  flex: none;
  color: var(--ink-2);
}
</style>
