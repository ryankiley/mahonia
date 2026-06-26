<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";
import { lineMg, formatWeight } from "~~/shared/weights";

const props = defineProps<{ list: ListSnapshot }>();

const segments = computed(() => {
  const total = props.list.items.reduce((s, i) => s + lineMg(i), 0);
  if (total <= 0) return [];
  return props.list.folders
    .map((f) => {
      const mg = props.list.items
        .filter((i) => i.folderId === f.id)
        .reduce((s, i) => s + lineMg(i), 0);
      return { id: f.id, name: f.name, colorKey: f.colorKey ?? "other", mg };
    })
    .filter((s) => s.mg > 0);
});
</script>

<template>
  <div v-if="segments.length" class="catbar">
    <!-- flex track: a small gap separates adjacent colours so they always read as distinct -->
    <div class="catbar__track" role="img" aria-label="Weight by folder">
      <span
        v-for="s in segments"
        :key="s.id"
        class="catbar__seg"
        :style="{ flexGrow: s.mg, background: `var(--cat-${s.colorKey})` }"
        :title="`${s.name} · ${formatWeight(s.mg, list.displayUnit)}`"
      />
    </div>
    <ul class="catbar__legend">
      <li v-for="s in segments" :key="s.id" class="catbar__item">
        <span class="swatch" :style="{ background: `var(--cat-${s.colorKey})` }" />
        <span class="catbar__name">{{ s.name }}</span>
        <span class="t-num t-sm t-muted">{{ formatWeight(s.mg, list.displayUnit) }}</span>
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
.catbar__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  margin-top: var(--space-3);
}
.catbar__item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.catbar__name {
  color: var(--ink-2);
}
</style>
