<script setup lang="ts">
import type { Classification, Folder, ListSnapshot } from "~~/shared/types";
import { lineMg, formatWeight } from "~~/shared/weights";

const props = defineProps<{ list: ListSnapshot; folder: Folder; packed: boolean }>();
const c = useGearList();

const items = computed(() =>
  props.list.items
    .filter((i) => i.folderId === props.folder.id)
    .sort((a, b) => a.sortOrder - b.sortOrder),
);

const folderMg = computed(() => items.value.reduce((s, i) => s + lineMg(i), 0));

const draftName = ref("");
const draftWeight = ref("");

function add() {
  if (!draftName.value.trim()) return;
  c.addItem(props.folder.id, {
    name: draftName.value,
    weight: draftWeight.value || undefined,
  });
  draftName.value = "";
  draftWeight.value = "";
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
      <input
        class="field folder__name"
        :value="folder.name"
        :disabled="packed"
        @change="c.updateFolder(folder.id, { name: ($event.target as HTMLInputElement).value })"
      />
      <span v-if="folderMg > 0" class="t-num t-micro t-muted">{{ formatWeight(folderMg, list.displayUnit) }}</span>
      <select
        v-if="!packed"
        class="field folder__class"
        :value="folder.defaultClassification"
        title="Default for items in this folder"
        @change="c.updateFolder(folder.id, { defaultClassification: ($event.target as HTMLSelectElement).value as Classification })"
      >
        <option v-for="o in CLASS_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <button
        v-if="!packed"
        class="btn btn--icon btn--ghost"
        title="Remove folder"
        aria-label="Remove folder"
        @click="c.removeFolder(folder.id)"
      >
        ✕
      </button>
    </header>

    <div class="folder__items">
      <ItemRow v-for="it in items" :key="it.id" :list="list" :item="it" :packed="packed" />
      <p v-if="!items.length && !packed" class="t-small t-faint folder__empty">No items yet.</p>
    </div>

    <div v-if="!packed" class="folder__add">
      <input
        v-model="draftName"
        class="field"
        placeholder="Add an item…"
        @keyup.enter="add"
      />
      <input
        v-model="draftWeight"
        class="field field--num folder__addw"
        :placeholder="`weight (${list.displayUnit})`"
        @keyup.enter="add"
      />
      <button class="btn btn--sm" @click="add">Add</button>
    </div>
  </section>
</template>

<style scoped>
.folder {
  border: 1px solid var(--line-2);
  background: var(--paper-2);
  padding: var(--space-3) var(--space-4) var(--space-4);
}
.folder__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--line);
  margin-bottom: var(--space-2);
}
.folder__dot {
  width: 10px;
  height: 10px;
  flex: none;
}
.folder__name {
  flex: 1;
  font-weight: 600;
  border-bottom-color: transparent;
}
.folder__name:focus {
  border-bottom-color: var(--accent);
}
.folder__class {
  width: auto;
  font-size: var(--t-micro);
  color: var(--ink-2);
}
.folder__empty {
  padding: var(--space-2) 0;
}
.folder__add {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px dashed var(--line);
}
.folder__addw {
  max-width: 120px;
}
</style>
