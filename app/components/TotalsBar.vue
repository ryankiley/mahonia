<script setup lang="ts">
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
        <span class="t-label">Total</span>
        <span v-if="totals.hasWeights" class="t-num totals__big">
          {{ formatWeight(totals.totalMg, list.displayUnit) }}
        </span>
        <span v-else class="t-muted totals__empty">Add weights to see your pack weight</span>
      </div>

      <div class="totals__controls">
        <select
          class="field unit-select"
          aria-label="Display unit"
          :value="list.displayUnit"
          @change="emit('set-unit', ($event.target as HTMLSelectElement).value as Unit)"
        >
          <option v-for="u in UNITS" :key="u" :value="u">{{ u }}</option>
        </select>
        <button
          v-if="!readonly"
          class="btn btn--sm"
          :aria-pressed="packed"
          @click="emit('update:packed', !packed)"
        >
          {{ packed ? "Editing" : "Packing" }}
        </button>
      </div>
    </div>

    <!-- the breakdown is always shown once any weights exist -->
    <div v-if="totals.hasWeights" class="totals__breakdown">
      <div class="totals__chips">
        <span class="chip"><span class="t-label">Base</span><span class="t-num">{{ formatWeight(totals.baseMg, list.displayUnit) }}</span></span>
        <span class="chip"><span class="t-label">Worn</span><span class="t-num">{{ formatWeight(totals.wornMg, list.displayUnit) }}</span></span>
        <span class="chip"><span class="t-label">Consumable</span><span class="t-num">{{ formatWeight(totals.consumableMg, list.displayUnit) }}</span></span>
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
.totals__big {
  font-size: var(--text-display);
  line-height: 0.95;
  letter-spacing: -0.02em;
  color: var(--accent);
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
.unit-select {
  width: auto;
  min-height: 32px;
  color: var(--ink-2);
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
  gap: 2px;
}
</style>
