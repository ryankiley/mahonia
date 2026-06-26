<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";
import { lineMg, formatWeight } from "~~/shared/weights";

const props = defineProps<{ list: ListSnapshot }>();

const segments = computed(() => {
  const total = props.list.items.reduce((s, i) => s + lineMg(i), 0);
  if (total <= 0) return [];
  let offset = 0;
  return props.list.folders
    .map((f) => {
      const mg = props.list.items
        .filter((i) => i.folderId === f.id)
        .reduce((s, i) => s + lineMg(i), 0);
      const pct = (mg / total) * 100;
      const seg = { id: f.id, name: f.name, colorKey: f.colorKey ?? "other", mg, pct, offset };
      offset += pct;
      return seg;
    })
    .filter((s) => s.mg > 0);
});
</script>

<template>
  <div v-if="segments.length" class="catbar">
    <svg
      class="catbar__svg"
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      role="img"
      aria-label="Weight by folder"
    >
      <rect
        v-for="s in segments"
        :key="s.id"
        :x="s.offset"
        :width="s.pct"
        y="0"
        height="6"
        :style="{ fill: `var(--cat-${s.colorKey})` }"
      />
    </svg>
    <ul class="catbar__legend">
      <li v-for="s in segments" :key="s.id" class="catbar__item">
        <span class="catbar__swatch" :style="{ background: `var(--cat-${s.colorKey})` }" />
        <span class="catbar__name">{{ s.name }}</span>
        <span class="t-num t-xs t-muted">{{ formatWeight(s.mg, list.displayUnit) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.catbar__svg {
  width: 100%;
  height: 6px;
  display: block;
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
  font-size: var(--text-xs);
}
.catbar__swatch {
  width: 10px;
  height: 10px;
  flex: none;
}
.catbar__name {
  color: var(--ink-2);
}
</style>
