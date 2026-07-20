<script lang="ts">
import type { Item as ItemT } from "~~/shared/types";

// one stable empty array for every leaf row — module scope so a large list
// doesn't mint a fresh identity per row
const NO_ITEMS: ItemT[] = [];
</script>

<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import type { Item, ListSnapshot } from "~~/shared/types";
import { effectiveClassification, formatWeight, rowDisplayMg } from "~~/shared/weights";
import { itemQtyLabel } from "~~/shared/water";

// The share views' row (/s + /l): name (a web-search link via <ItemName search>),
// amount, line weight — and its nested children, rendered the SAME way one level down
// (indented), exactly mirroring the editor. Deliberately its OWN component, not ItemRow
// with a flag — the read pages must not pull the editor graph (autocomplete, drag,
// useGearList, the modals) into their bundle just to render static text.
//
// `childrenByParent` is one groupItemsByParent pass per snapshot (ReadonlyListView),
// threaded to every row so rows don't each re-scan the whole item array.
const props = withDefaults(
  defineProps<{
    list: ListSnapshot;
    item: Item;
    childrenByParent: Map<string, Item[]>;
    nested?: boolean;
  }>(),
  { nested: false },
);

const effClass = computed(() => effectiveClassification(props.item, props.list.folders));
// one level of nesting: a nested row never renders its own children
const children = computed(() =>
  props.nested ? NO_ITEMS : (props.childrenByParent.get(props.item.id) ?? NO_ITEMS),
);
const isParent = computed(() => children.value.length > 0);
// a group shows its total (own + children); a leaf shows its own line weight
// (`children` holds exactly this row's children, so the sum is O(children))
const rowWeightMg = computed(() => rowDisplayMg(props.item, children.value));
// nested groups start CLOSED in a shared list — it reads compact (the group total is
// shown; expand to see the members). Local + per-view, NEVER persisted, matching
// ReadonlyFolderSection (the owner's editor collapse can't bleed into the share).
const collapsed = ref(true);
</script>

<template>
  <div class="ro-wrap">
    <div class="item-row item item--ro">
      <span class="item__roname" :class="{ 'item__roname--group': isParent }">
        <span class="item__ronametext"><ItemName :item="item" search /><span v-if="effClass !== 'base'" class="t-sm item__class"> · {{ effClass }}</span></span>
        <!-- collapse a group of nested items — trails the name like the folder chevron.
             The name text truncates so a long group name never shoves the chevron off. -->
        <button
          v-if="isParent"
          class="item__nestcollapse"
          :aria-expanded="!collapsed"
          :aria-label="`${collapsed ? 'Expand' : 'Collapse'} ${item.name || 'group'}`"
          :title="collapsed ? 'Expand group' : 'Collapse group'"
          @click="collapsed = !collapsed"
        >
          <ChevronDown class="item__nestchev" :class="{ 'is-collapsed': collapsed }" :size="16" :stroke-width="2" />
        </button>
      </span>
      <span class="t-num t-sm t-muted item__roqty">{{ itemQtyLabel(item, effClass) }}</span>
      <!-- separate the qty and weight columns in the TEXT stream. On screen they're
           distinct grid cells, but flattened text (crawlers, LLMs, plain scrapers of
           this SSR'd share page) concatenates "×1" + "206" into "1206" — reading every
           weight ~1000 g heavy. A visually-hidden delimiter keeps them apart for those
           readers with no visual change (position:absolute → takes no grid cell). -->
      <span class="visually-hidden"> · </span>
      <span class="t-num item__roweight"><template v-if="rowWeightMg > 0">{{ formatWeight(rowWeightMg, list.displayUnit, { withUnit: false }) }}<span class="t-muted item__wunit">{{ list.displayUnit }}</span></template><template v-else>—</template></span>
      <!-- the owner's note travels with the share (it used to be silently dropped here);
           same quiet caption voice as the editor's note field -->
      <p v-if="item.description" class="t-sm item__ronote">{{ item.description }}</p>
    </div>
    <!-- nested items: the same read row, indented one level (their weights sum into the
         group total shown above). Collapsed by default in the share view. -->
    <div v-if="isParent" class="nestcollapse" :data-collapsed="collapsed || null">
      <div class="ro-nest nest-block">
        <ReadonlyItemRow
          v-for="child in children"
          :key="child.id"
          :list="list"
          :item="child"
          :children-by-parent="childrenByParent"
          nested
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.item--ro {
  /* the grid scaffold (display / columns / align / gap) is the shared .item-row base
     (atoms/item.scss); the read row only feeds it the read column token. baseline align +
     --item-gap are the base defaults, so nothing else to set here.
     vertical padding comes from the row wrapper (.folder__items > * / .ro-nest > *) so the
     rule lines between items sit at a consistent rhythm. */
  --row-cols: var(--item-cols-ro);
}
.item__roname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* a GROUP (parent) row: the name + trailing collapse chevron, mirroring the editor's
   ItemRow / a folder header. The name is a link so it hugs its text naturally. */
.item__roname--group {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  overflow: visible;
}
/* the name text truncates within the group flex so a long name never pushes the
   chevron off the row edge (the chevron is flex:none, always kept) */
.item__roname--group .item__ronametext {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* the collapse chevron button + its rotate + touch tap target are the shared
   .item__nestcollapse / .item__nestchev recipe in atoms/item.scss (identical to the
   editor's), so a group chevron looks the same in the editor and the share views. */
/* the read-only name is a web-search link (look up / buy the gear) — see ItemName.vue,
   which owns the dotted underline + search icon so the underline wraps only the product
   name, not the variant. */
.item__roweight {
  text-align: right;
}
/* the qty/amount label lives in the narrow 44px column; keep it on one line so a water
   row's volume ("1.75 L") never breaks between the number and its "L" unit. */
.item__roqty {
  white-space: nowrap;
}
/* the unit suffix gap (.item__wunit) is shared with the editor's rows — atoms/item.scss */
/* classification reads from its text label, not colour (chrome stays monochrome) */
.item__class {
  color: var(--ink-2);
}
/* the note — a full-width caption line under the row, in the editor note's quiet voice
   (lightest ink, italic) */
.item__ronote {
  grid-column: 1 / -1;
  /* same tuck as the editor's note (.reveal--note) via the shared token, so the
     caption sits the SAME distance under the name in read + edit — no drift */
  margin-top: var(--caption-tuck);
  color: var(--ink-3);
  font-style: italic;
}
/* the nested block's thread-line container is the shared .nest-block atom
   (atoms/item.scss), rendered identically by the editor's ItemRow */

@media (max-width: $bp-stack) {
  /* two-line shape (mirrors the editor's mobile rows): the name takes its own line and
     wraps (never clips), and ×qty + weight sit together on a second line, flush-left —
     instead of the weight stranded out at the far-right margin. */
  .item--ro {
    /* two-line stack via the shared .item-row grid: the name takes row 1, ×qty · weight
       row 2 (cell placements below). Only the columns, centre-align + gap change here. */
    --row-cols: auto 1fr;
    --row-align: center;
    --row-gap: var(--space-1) var(--space-3); /* row-gap · column-gap */
  }
  .item__roname {
    grid-column: 1 / -1;
    grid-row: 1;
    white-space: normal;
    overflow: visible;
  }
  /* a GROUP name gets its own full-width line here (like a leaf name), so let it
     wrap and be fully read — the desktop nowrap/ellipsis (to keep the chevron on a
     fixed-width grid column) isn't needed once the name owns the row */
  .item__roname--group .item__ronametext {
    white-space: normal;
    overflow: visible;
  }
  .item__roqty {
    grid-column: 1;
    grid-row: 2;
  }
  /* the qty/weight cells' compact box metrics are shared with the editor's rows —
     atoms/item.scss */
  .item__roweight {
    grid-column: 2;
    grid-row: 2;
    justify-self: start;
    text-align: left;
  }
  /* third line on the two-line mobile shape; the row-gap provides the spacing, so drop
     the desktop's upward tuck */
  .item__ronote {
    grid-column: 1 / -1;
    grid-row: 3;
    margin-top: 0;
  }
}
</style>
