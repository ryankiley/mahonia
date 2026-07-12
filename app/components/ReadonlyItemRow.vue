<script setup lang="ts">
import type { Item, ListSnapshot } from "~~/shared/types";
import { effectiveClassification, formatWeight, lineMg } from "~~/shared/weights";
import { itemQtyLabel } from "~~/shared/water";

// The share views' row (/s + /l): name (a web-search link via <ItemName search>),
// amount, line weight. Deliberately its OWN component, not ItemRow with a flag —
// the read pages must not pull the editor graph (autocomplete, drag-to-reorder,
// useGearList, the modals) into their bundle just to render static text.
const props = defineProps<{ list: ListSnapshot; item: Item }>();

const effClass = computed(() => effectiveClassification(props.item, props.list.folders));
</script>

<template>
  <div class="item item--ro">
    <span class="item__roname">
      <ItemName :item="item" search /><span v-if="effClass !== 'base'" class="t-sm item__class"> · {{ effClass }}</span>
    </span>
    <span class="t-num t-sm t-muted item__roqty">{{ itemQtyLabel(item, effClass) }}</span>
    <span class="t-num item__roweight"><template v-if="item.unitWeightMg > 0">{{ formatWeight(lineMg(item), list.displayUnit, { withUnit: false }) }}<span class="t-muted item__wunit">{{ list.displayUnit }}</span></template><template v-else>—</template></span>
    <!-- the owner's note travels with the share (it used to be silently dropped
         here); same quiet caption voice as the editor's note field -->
    <p v-if="item.description" class="t-sm item__ronote">{{ item.description }}</p>
  </div>
</template>

<style scoped>
.item--ro {
  display: grid;
  grid-template-columns: var(--item-cols-ro);
  align-items: baseline;
  gap: var(--item-gap);
  /* vertical padding comes from the row wrapper (.folder__items > *) so the rule
     lines between items sit at a consistent rhythm */
}
.item__roname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* the read-only name is a web-search link (look up / buy the gear) — see
   ItemName.vue, which owns the dotted underline + search icon so the underline
   wraps only the product name, not the variant. */
.item__roweight {
  text-align: right;
}
/* the qty/amount label lives in the narrow 44px column; keep it on one line so a
   water row's volume ("1.75 L") never breaks between the number and its "L" unit. */
.item__roqty {
  white-space: nowrap;
}
/* unit suffix on the weight — an explicit gap from the number so it doesn't
   crowd ("1200g"); matches the editing row's --space-1 unit gap */
.item__wunit {
  margin-inline-start: var(--space-1);
}
/* classification reads from its text label, not colour (chrome stays monochrome) */
.item__class {
  color: var(--ink-2);
}
/* the note — a full-width caption line under the row, in the editor note's quiet
   voice (lightest ink, italic) */
.item__ronote {
  grid-column: 1 / -1;
  margin-top: calc(-1 * var(--space-1));
  color: var(--ink-3);
  font-style: italic;
}

@media (max-width: 560px) {
  /* two-line shape (mirrors the editor's mobile rows): the name takes its own line
     and wraps (never clips), and ×qty + weight sit together on a second line,
     flush-left — instead of the weight stranded out at the far-right margin. */
  .item--ro {
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: var(--space-3);
    row-gap: var(--space-1);
  }
  .item__roname {
    grid-column: 1 / -1;
    grid-row: 1;
    white-space: normal;
    overflow: visible;
  }
  .item__roqty {
    grid-column: 1;
    grid-row: 2;
  }
  .item__roqty,
  .item__roweight {
    padding-block: 2px;
    line-height: 1.3;
    display: inline-flex;
    align-items: center;
  }
  .item__roweight {
    grid-column: 2;
    grid-row: 2;
    justify-self: start;
    text-align: left;
  }
  /* third line on the two-line mobile shape; the row-gap provides the spacing,
     so drop the desktop's upward tuck */
  .item__ronote {
    grid-column: 1 / -1;
    grid-row: 3;
    margin-top: 0;
  }
}
</style>
