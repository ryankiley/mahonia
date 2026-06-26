<script setup lang="ts">
import type { Classification, Folder, ListSnapshot } from "~~/shared/types";
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

const CLASS_OPTS: { value: Classification; label: string }[] = [
  { value: "base", label: "Base" },
  { value: "worn", label: "Worn" },
  { value: "consumable", label: "Consumable" },
];
</script>

<template>
  <section class="folder">
    <header class="folder__head">
      <span class="folder__dot" :style="{ background: `var(--cat-${folder.colorKey ?? 'other'})` }" />
      <span v-if="readonly" class="folder__name">{{ folder.name }}</span>
      <input
        v-else
        class="field folder__name"
        :value="folder.name"
        :disabled="packed"
        @change="c.updateFolder(folder.id, { name: ($event.target as HTMLInputElement).value })"
      />
      <span v-if="folderMg > 0" class="t-num t-sm t-muted">{{ formatWeight(folderMg, list.displayUnit) }}</span>
      <select
        v-if="!packed && !readonly"
        class="field folder__class"
        :value="folder.defaultClassification"
        title="Default for items in this folder"
        @change="c.updateFolder(folder.id, { defaultClassification: ($event.target as HTMLSelectElement).value as Classification })"
      >
        <option v-for="o in CLASS_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <button
        v-if="!packed && !readonly"
        class="btn btn--icon btn--ghost"
        title="Remove folder"
        aria-label="Remove folder"
        @click="c.removeFolder(folder.id)"
      >
        ✕
      </button>
    </header>

    <div class="folder__items">
      <ItemRow v-for="it in items" :key="it.id" :list="list" :item="it" :packed="packed" :readonly="readonly" />
      <p v-if="!items.length && !packed && !readonly" class="t-sm t-muted folder__empty">No items yet.</p>
      <p v-else-if="!items.length && readonly" class="t-sm t-muted folder__empty">—</p>
    </div>

    <div v-if="!packed && !readonly" class="folder__add">
      <ItemInput :unit="list.displayUnit" @commit="onCommit" />
    </div>
  </section>
</template>

<style scoped>
/* de-outlined: no card box — the heading + the colored dot + whitespace separate folders */
.folder {
  padding: 0;
}
.folder__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin-bottom: var(--space-1);
}
.folder__dot {
  width: 8px;
  height: 8px;
  flex: none;
  align-self: center;
}
.folder__name {
  flex: 1;
  font-weight: 600;
  font-size: var(--text-title);
  letter-spacing: -0.02em;
}
.folder__class {
  width: auto;
  font-size: var(--text-sm);
  color: var(--ink-2);
}
.folder__empty {
  padding: var(--space-2) 0;
}
.folder__add {
  margin-top: var(--space-1);
}
.folder__addinput {
  width: 100%;
  color: var(--ink-2);
}
</style>
