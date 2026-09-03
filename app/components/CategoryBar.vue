<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";
import { categoryColor } from "~~/shared/categories";
import { categorySegments } from "~~/shared/discovery";
import { formatWeight } from "~~/shared/weights";

const props = defineProps<{ list: ListSnapshot }>();

// one folder-grouped rollup (sorted by weight; ungrouped items fold into
// "Other"); empty / weightless lists give []
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

<style scoped lang="scss">
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
/* TEXT FLOW, not a flex row. A folder name is as long as its owner made it, and once
   one wrapped, a flex row put the dot in the middle of the block (align-self: center
   centres against the whole item, not the line it belongs to) and left the weight up
   on the first line with the rest of the name running underneath it — a number with
   text flowing under it reads as a different column, not as this entry's figure.
   Inline, the three parts read as one line of text that happens to wrap: dot first,
   weight trailing the name it belongs to. The hanging indent (padding + negative
   text-indent, both off --swatch) keeps the wrapped lines under the NAME rather than
   under the dot, so the dot reads as the bullet it is. */
.catbar__item {
  font-size: var(--text-base);
  padding-inline-start: calc(var(--swatch) + var(--space-2));
  text-indent: calc(-1 * (var(--swatch) + var(--space-2)));
}
.swatch {
  display: inline-block;
  /* Centred on the CAP box, not the x-height. `vertical-align: middle` is the reflex
     here, but it centres a box on the baseline plus half the x-height — and the label
     beside it is a 600-weight line with no descenders, whose optical centre is half its
     cap height. The two differ by (cap − x-height) / 2, about 1.4px at this size, and
     the dot read that much low. As a length, vertical-align raises the dot's bottom
     edge off the baseline instead: 0.04em leaves an equal sliver of cap above and below
     a --swatch dot, and being an em it holds if the type scale moves. */
  vertical-align: 0.04em;
  margin-inline-end: var(--space-2);
}
/* folder names read as labels — same treatment as the Base/Worn chips (t-label):
   strong weight, secondary ink. The figure beside them keeps full ink. */
.catbar__name {
  font-weight: 600;
  color: var(--ink-2);
}
/* the figure carries the data (full ink); its unit is secondary (--ink-2, the one
   de-emphasis level — same as every other unit), and the two sit tight as one
   "1,300 g" pair — which trails the name's last word rather than breaking from it.
   text-indent is reset because the hanging indent above belongs to the ITEM, and a
   browser that applied it to this inline box would pull the figure over the name. */
.catbar__wt {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-px);
  margin-inline-start: var(--space-2);
  text-indent: 0;
}
.catbar__num {
  color: var(--ink);
}
.catbar__unit {
  color: var(--ink-2);
}
/* roomier separation between folder entries when they sit on one line on a phone */
@media (max-width: $bp-stack) {
  .catbar__legend {
    column-gap: var(--space-6);
  }
}
</style>
