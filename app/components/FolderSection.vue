<script setup lang="ts">
import { X } from "@lucide/vue";
import type { Folder, ListSnapshot } from "~~/shared/types";
import { lineMg, formatWeight } from "~~/shared/weights";

const props = withDefaults(
  defineProps<{ list: ListSnapshot; folder: Folder; packed?: boolean; readonly?: boolean }>(),
  { packed: false, readonly: false },
);
const c = useGearList();

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
</script>

<template>
  <section class="folder">
    <header class="folder__head">
      <div class="folder__title">
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
        <X :size="16" />
      </button>
    </header>

    <TransitionGroup name="item" tag="div" class="folder__items">
      <ItemRow v-for="it in items" :key="it.id" :list="list" :item="it" :packed="packed" :readonly="readonly" />
      <p v-if="!items.length && !packed && !readonly" key="empty" class="t-sm t-muted folder__empty">No items yet.</p>
      <p v-else-if="!items.length && readonly" key="empty-ro" class="t-sm t-muted folder__empty">—</p>
    </TransitionGroup>

    <div v-if="!packed && !readonly" class="folder__add">
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
  grid-template-columns: 1fr 56px 84px 110px 68px;
  gap: var(--space-3);
  align-items: baseline;
  margin-bottom: var(--space-1);
}
.folder__title {
  grid-column: 1 / 3;
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  min-width: 0;
}
.folder__name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: var(--text-title);
  letter-spacing: -0.02em;
}
.folder__weight {
  grid-column: 3;
  text-align: right;
  white-space: nowrap;
}
.folder__del {
  grid-column: 5;
  justify-self: end;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.folder:hover .folder__del,
.folder:focus-within .folder__del {
  opacity: 1;
}
@media (hover: none) {
  .folder__del {
    opacity: 1;
  }
}

@media (max-width: 560px) {
  .folder__head {
    grid-template-columns: 1fr auto auto;
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
}
/* rule lines between items — a quiet spec-sheet rhythm; padding here (not on the
   rows) keeps the gap above/below each rule consistent across all row types */
.folder__items > * {
  padding-block: var(--space-2);
}
.folder__items > * + * {
  border-top: 1px solid var(--line);
}
.folder__empty {
  color: var(--ink-3);
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
.folder__addinput {
  width: 100%;
  color: var(--ink-2);
}
</style>
