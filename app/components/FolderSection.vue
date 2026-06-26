<script setup lang="ts">
import { ChevronDown, CircleMinus } from "@lucide/vue";
import type { Folder, ListSnapshot } from "~~/shared/types";
import { lineMg, formatWeight } from "~~/shared/weights";

const props = withDefaults(
  defineProps<{ list: ListSnapshot; folder: Folder; packed?: boolean; readonly?: boolean }>(),
  { packed: false, readonly: false },
);
const c = useGearList();

// drag-to-reorder: this folder is a drop zone; show a tail line when an item is
// being dragged to the end of it (no specific row targeted)
const dnd = useItemDnd();
const isAppendTarget = computed(
  () =>
    dnd.dragId.value != null &&
    dnd.drop.value?.folderId === props.folder.id &&
    dnd.drop.value?.beforeId == null,
);

const items = computed(() =>
  props.list.items
    .filter((i) => i.folderId === props.folder.id)
    .sort((a, b) => a.sortOrder - b.sortOrder),
);

const folderMg = computed(() => items.value.reduce((s, i) => s + lineMg(i), 0));

// add via the Maps-grade ItemInput: a catalog pick fills name/brand/weight + links
// the catalog id; free text falls back to a typed name (+ optional trailing weight).
function onCommit(p: {
  name: string;
  brand?: string;
  weight?: string;
  weightMg?: number;
  catalogItemId?: number;
}) {
  c.addItem(props.folder.id, p);
}

// collapse: the chevron shows/hides the folder body. Persisted per folder id so a
// collapsed folder stays collapsed across reloads (pure UI state, not synced).
const COLLAPSE_KEY = `gear.fold.${props.folder.id}`;
const collapsed = ref(false);
onMounted(() => {
  try {
    collapsed.value = localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    /* private mode / no storage — default expanded */
  }
});
function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <section class="folder" :data-folder="folder.id">
    <header class="folder__head" :class="{ 'folder__head--ro': readonly, 'folder__head--packed': packed }">
      <div class="folder__title">
        <button
          class="folder__collapse"
          :aria-expanded="!collapsed"
          :aria-label="`${collapsed ? 'Expand' : 'Collapse'} ${folder.name || 'folder'}`"
          :title="collapsed ? 'Expand folder' : 'Collapse folder'"
          @click="toggleCollapsed"
        >
          <ChevronDown class="folder__chev" :class="{ 'is-collapsed': collapsed }" :size="18" :stroke-width="2" />
        </button>
        <span v-if="readonly" class="folder__name">{{ folder.name }}</span>
        <input
          v-else
          class="field folder__name"
          :value="folder.name"
          :disabled="packed"
          @change="c.updateFolder(folder.id, { name: ($event.target as HTMLInputElement).value })"
        />
      </div>
      <span v-if="folderMg > 0" class="t-num t-sm t-muted folder__weight">{{ formatWeight(folderMg, list.displayUnit) }}</span>
      <button
        v-if="!packed && !readonly"
        class="btn btn--icon btn--ghost folder__del"
        title="Remove folder"
        aria-label="Remove folder"
        @click="c.removeFolder(folder.id)"
      >
        <CircleMinus :size="16" />
      </button>
    </header>

    <TransitionGroup v-show="!collapsed" name="item" tag="div" class="folder__items">
      <ItemRow v-for="it in items" :key="it.id" :list="list" :item="it" :packed="packed" :readonly="readonly" />
      <p v-if="!items.length && readonly" key="empty-ro" class="t-sm t-muted folder__empty">—</p>
    </TransitionGroup>

    <div v-if="isAppendTarget && !collapsed" class="folder__droptail" aria-hidden="true" />

    <div v-if="!packed && !readonly" v-show="!collapsed" class="folder__add">
      <!-- one add affordance: type an item name, or a water volume ("1 L", "500 ml",
           "water 1l") → the autocomplete surfaces a Water option -->
      <ItemInput :unit="list.displayUnit" with-weight @commit="onCommit" />
    </div>
  </section>
</template>

<style scoped>
/* de-outlined: no card box — the heading + the colored dot + whitespace separate folders */
.folder {
  padding: 0;
}
/* same column template as ItemRow so folder totals line up with item weights */
.folder__head {
  display: grid;
  grid-template-columns: var(--item-cols);
  gap: var(--item-gap);
  align-items: baseline;
  margin-bottom: var(--space-1);
}
/* read view: match the read-only item template so folder totals line up with item weights */
.folder__head--ro {
  grid-template-columns: var(--item-cols-ro);
}
/* packing mode: match the checklist item grid (auto 1fr 44px 96px) so the folder
   total lines up with the per-item weights (both right-aligned in the last col) */
.folder__head--packed {
  grid-template-columns: auto var(--item-cols-ro);
}
/* read view: 3-col template (name · qty · weight), no grip column — keep the title
   at name+qty and the total in the last col */
.folder__head--ro .folder__title {
  grid-column: 1 / 3;
}
.folder__head--ro .folder__weight {
  grid-column: 3;
}
/* editor + packing share a leading column (grip / checkbox), so the title spans
   the first three tracks — the folder name starts at the page edge, above the
   indented item rows, while the total stays aligned with item weights */
.folder__title {
  grid-column: 1 / 4;
  display: flex;
  align-items: baseline;
  gap: var(--item-gap);
  min-width: 0;
}
/* collapse toggle sits in the leading gutter (like the item grip), so the folder
   name lands at the same column as the item names below it */
.folder__collapse {
  flex: none;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  padding: 0;
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.folder__collapse:hover {
  color: var(--ink);
}
.folder__chev {
  transition: transform var(--dur) var(--ease);
}
.folder__chev.is-collapsed {
  transform: rotate(-90deg);
}
.folder__name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: var(--text-title);
  letter-spacing: -0.02em;
}
.folder__weight {
  grid-column: 4;
  text-align: right;
  white-space: nowrap;
}
.folder__del {
  grid-column: 6;
  justify-self: end;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.folder__del:hover {
  color: var(--ink);
}

@media (max-width: 560px) {
  .folder__head {
    grid-template-columns: 1fr auto auto;
  }
  /* keep packing mode matching the checklist grid so the folder total stays
     aligned with item weights on mobile too */
  .folder__head--packed {
    grid-template-columns: auto var(--item-cols-ro);
  }
  .folder__title {
    grid-column: 1;
  }
  .folder__weight {
    grid-column: auto;
  }
  .folder__del {
    grid-column: auto;
  }
  /* tighten the two-row mobile items so each row reads as one unit, not spaced out */
  .folder__items > * {
    padding-block: var(--space-2);
  }
}
/* rule lines between items — a quiet spec-sheet rhythm; padding here (not on the
   rows) keeps the gap above/below each rule consistent across all row types */
.folder__items > * {
  padding-block: var(--space-3);
}
.folder__items > * + * {
  border-top: 1px solid var(--line);
}
.folder__empty {
  color: var(--ink-3);
}
/* drag-to-reorder: insertion line when dropping at the end of this folder */
.folder__droptail {
  height: var(--space-px);
  background: var(--ink);
  margin: var(--space-1) 0;
}
/* a newly added item rises + fades in (initial load stays static — no `appear`) */
.item-enter-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.item-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.folder__add {
  border-top: 1px solid var(--line);
  padding-top: var(--space-2);
  margin-top: 0;
}
</style>
