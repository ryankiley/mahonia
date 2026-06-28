<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";
import { categoryColor } from "~~/shared/categories";
import { categorySegments } from "~~/shared/discovery";
import { formatWeight } from "~~/shared/weights";

const props = defineProps<{ list: ListSnapshot }>();

// one folder-grouped rollup, shared with the discovery feed's spark (sorted by
// weight; ungrouped items fold into "Other"); empty / weightless lists give []
const segments = computed(() => categorySegments(props.list));
</script>

<template>
  <div class="catbar">
    <!-- flex track: a small gap separates adjacent colours so they always read as distinct.
         empty lists keep a single blank rail so the bar never reflows in when the first
         weighted item lands -->
    <div class="catbar__track" role="img" aria-label="Weight by folder">
      <span
        v-for="(s, i) in segments"
        :key="i"
        class="catbar__seg"
        :style="{ flexGrow: s.mg, background: categoryColor(s.colorKey) }"
        :title="`${s.name} · ${formatWeight(s.mg, list.displayUnit)}`"
      />
      <span v-if="!segments.length" class="catbar__seg catbar__seg--blank" />
    </div>
    <ul v-if="segments.length" class="catbar__legend">
      <li v-for="(s, i) in segments" :key="i" class="catbar__item">
        <span class="swatch" :style="{ background: categoryColor(s.colorKey) }" />
        <span class="catbar__name">{{ s.name }}</span>
        <span class="catbar__wt">
          <span class="t-num t-sm catbar__num">{{ formatWeight(s.mg, list.displayUnit, { withUnit: false }) }}</span>
          <span class="t-sm catbar__unit">{{ list.displayUnit }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.catbar__track {
  display: flex;
  gap: var(--space-px);
  height: var(--bar-h);
}
.catbar__seg {
  flex-basis: 0;
  min-width: var(--bar-seg-min);
}
.catbar__seg--blank {
  flex-grow: 1;
  background: var(--line);
}
.catbar__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
  margin-top: var(--space-3);
}
.catbar__item {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.swatch {
  align-self: center;
}
/* folder names read as labels — same treatment as the Base/Worn chips (t-label):
   strong weight, secondary ink. The figure beside them keeps full ink. */
.catbar__name {
  font-weight: 600;
  color: var(--ink-2);
}
/* the figure carries the data (full ink); its unit is secondary (--ink-2, the one
   de-emphasis level — same as every other unit), and the two sit tight as one
   "1,300 g" pair */
.catbar__wt {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-px);
}
.catbar__num {
  color: var(--ink);
}
.catbar__unit {
  color: var(--ink-2);
}
/* roomier separation between folder entries when they sit on one line on a phone */
@media (max-width: 560px) {
  .catbar__legend {
    column-gap: var(--space-6);
  }
}
</style>
