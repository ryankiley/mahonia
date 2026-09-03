<script setup lang="ts">
import { personColor, type PersonShare } from "~~/shared/people";
import type { ListSnapshot } from "~~/shared/types";
import { formatWeight } from "~~/shared/weights";

// The list divided by carrier, one block per person: whose, what they carry,
// and the same folder bar the whole list gets above — so Sam's shelter, food
// and pack sit next to Alex's without flipping the person chips back and forth.
//
// Dumb on purpose, like PeopleBar: the shares arrive computed (shared/people.ts
// personShares, the one bucketing pass the chips also read), and each block is a
// CategoryBar handed that person's rows. The bar is the list's folder colours,
// so a block's legend matches the legend above it — nothing new to learn.
const props = defineProps<{
  list: ListSnapshot;
  shares: readonly PersonShare[];
}>();

// each share as the list it is — the whole list's folders and unit, that
// person's rows. Built here, once per change, rather than inline in the
// template, where a fresh object per render would re-run every bar's rollup.
const rows = computed(() =>
  props.shares.map((s) => ({
    key: s.key,
    name: s.person?.name ?? "Unassigned",
    color: s.person ? personColor(s.person) : undefined,
    mg: s.mg,
    list: { ...props.list, items: s.items },
  })),
);
</script>

<template>
  <ul class="ppb" aria-label="Weight by person">
    <li v-for="r in rows" :key="r.key" class="ppb__row">
      <p class="ppb__who">
        <!-- the person's dot from their chip; the unclaimed bucket's hollow one -->
        <span
          class="swatch"
          :class="{ 'swatch--hollow': !r.color }"
          :style="r.color ? { background: r.color } : undefined"
          aria-hidden="true"
        />
        <span class="ppb__name">{{ r.name }}</span>
        <span class="ppb__wt">
          <span class="t-num ppb__num">{{ formatWeight(r.mg, list.displayUnit, { withUnit: false }) }}</span>
          <span class="ppb__unit">{{ list.displayUnit }}</span>
        </span>
      </p>
      <CategoryBar :list="r.list" :label="`${r.name}’s weight by folder`" />
    </li>
  </ul>
</template>

<style scoped lang="scss">
.ppb {
  display: flex;
  flex-direction: column;
  /* one block per person, each a name over a bar over a legend — a step wider
     than the legend's own row gap, so the blocks read as blocks and not as one
     long legend */
  gap: var(--space-5);
  /* the same step off the whole list's legend above: the breakdown's own gap is
     --space-4, and topped up by one, the list's bar reads as the first block of
     this series — Everyone, then each person — on one rhythm, rather than the
     first person's name hanging off the list's legend as a fifth entry */
  margin-top: var(--space-1);
}
.ppb__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.ppb__who {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
/* the name is the block's label — the folder-legend treatment (strong weight,
   secondary ink), so the whole block reads as one more line of that table */
.ppb__name {
  font-weight: 600;
  color: var(--ink-2);
}
/* the carry: full ink on the figure, secondary on the unit, the pair sitting
   tight — the legend's own "1,300 g" shape, one level up */
.ppb__wt {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-px);
}
.ppb__num {
  color: var(--ink);
}
.ppb__unit {
  color: var(--ink-2);
}
</style>
