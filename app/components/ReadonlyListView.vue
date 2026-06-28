<script setup lang="ts">
import type { ListSnapshot, Totals, Unit } from "~~/shared/types";

// The shared body for the two read-only pages (/s/[code] + /l/[slug]). Both render
// the same totals + folder/ungrouped block over the same useReadonlyList view-model
// (kept in the page); only the head, footer, and missing-state copy differ, so those
// are slots. This is purely the shared template + .view CSS — no data shaping.
defineProps<{
  list: ListSnapshot | null;
  totals: Totals | null;
  shownFolders: ListSnapshot["folders"];
  ungrouped: ListSnapshot["items"];
}>();

defineEmits<{ "set-unit": [Unit] }>();
</script>

<template>
  <main v-if="list && totals" class="wrap view">
    <slot name="head">
      <h1 class="t-title view__title">{{ list.title }}</h1>
    </slot>

    <TotalsBar :list="list" :totals="totals" @set-unit="(u) => $emit('set-unit', u)" />

    <div class="view__folders">
      <FolderSection v-for="f in shownFolders" :key="f.id" :list="list" :folder="f" readonly />
      <section v-if="ungrouped.length">
        <p class="t-label view__ungrouped">Ungrouped</p>
        <ItemRow v-for="it in ungrouped" :key="it.id" :list="list" :item="it" readonly />
      </section>
    </div>

    <slot name="footer" />
  </main>

  <main v-else class="wrap view view--missing">
    <p class="t-muted"><slot name="missing">This list doesn’t exist (or was removed).</slot></p>
    <NuxtLink to="/" class="btn btn--primary">Make a list</NuxtLink>
  </main>
</template>

<style scoped>
.view {
  /* no bottom padding: the footer's own margin-top is the single content→footer
     gap (matches the inter-folder rhythm), so this row doesn't double it up */
  padding-block: var(--space-5) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.view__title {
  font-family: var(--font);
}
.view__folders {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}
.view__ungrouped {
  margin-bottom: var(--space-1);
}
.view--missing {
  padding-block: var(--space-9);
  align-items: flex-start;
}
</style>
