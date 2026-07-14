<script setup lang="ts">
import type { Item, ListSnapshot, Totals, Unit } from "~~/shared/types";
import { groupItemsByFolder } from "~~/shared/weights";

// The shared body for the two read-only pages (/s/[code] + /l/[slug]). Both render
// the same totals + folder/ungrouped block over the same useReadonlyList view-model
// (kept in the page); only the head, footer, and missing-state copy differ, so those
// are slots. This is purely the shared template + .view CSS — no data shaping
// (beyond the per-folder grouping every ReadonlyFolderSection consumes).
const props = defineProps<{
  list: ListSnapshot | null;
  totals: Totals | null;
  shownFolders: ListSnapshot["folders"];
  ungrouped: ListSnapshot["items"];
}>();

defineEmits<{ "set-unit": [Unit] }>();

// one grouping pass for all folders (ReadonlyFolderSection takes its items pre-grouped)
const itemsByFolder = computed(() => groupItemsByFolder(props.list?.items ?? []));
const NO_ITEMS: Item[] = [];

// Quiet meta line under the title — the page's read-only status (a #status slot:
// "Read-only" / "Public list") joined with the list's last-edit time into one text
// object. The time is the read-only twin of the editor's SyncStatus suffix: no sync
// words (the viewer isn't writing), just the last server write via the shared
// timeAgo(), so a share link tells the reader how fresh the list is. Ticks silently.
const now = useNow({ interval: 30_000 });
const editedAt = computed(() => {
  const iso = props.list?.updatedAt;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
});
</script>

<template>
  <main v-if="list && totals" class="wrap view">
    <div class="view__header">
      <slot name="head">
        <h1 class="t-title view__title">{{ list.title }}</h1>
      </slot>
      <p v-if="$slots.status || editedAt != null" class="view__meta">
        <span v-if="$slots.status" class="view__status"><slot name="status" /></span>
        <!-- the relative time is a client concern (avoids an SSR/hydration time
             mismatch on the indexable /l page); the dot only shows once it does -->
        <ClientOnly>
          <template v-if="editedAt != null">
            <span v-if="$slots.status" class="view__dot" aria-hidden="true">•</span>
            <span>Edited {{ timeAgo(editedAt, now.getTime()) }}</span>
          </template>
        </ClientOnly>
      </p>
    </div>

    <TotalsBar :list="list" :totals="totals" @set-unit="(u) => $emit('set-unit', u)" />

    <div class="view__folders">
      <ReadonlyFolderSection v-for="f in shownFolders" :key="f.id" :list="list" :folder="f" :items="itemsByFolder.get(f.id) ?? NO_ITEMS" />
      <section v-if="ungrouped.length">
        <p class="t-label view__ungrouped">Ungrouped</p>
        <ReadonlyItemRow v-for="it in ungrouped" :key="it.id" :list="list" :item="it" />
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
/* the title/head block and its trailing "Edited …" line, kept tight (--space-1) so
   the name + its status/time read as one unit, one --space-6 step off TotalsBar */
.view__header {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.view__title {
  font-family: var(--font);
}
/* status · edited — one quiet line. flex so a #status icon (the /l globe) sits on the
   text baseline, with a drawn middle-dot between the pieces */
.view__meta {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  font-size: var(--text-sm);
}
.view__status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
/* the separator is its own flex child (aria-hidden) so it isn't announced/copied. A
   bullet (•) reads bigger than a middle-dot at the same size; a small negative inline
   margin pulls the status + time a touch closer than the meta's flex gap. */
.view__dot {
  color: var(--ink-3);
  line-height: 1;
  margin-inline: -2px;
}
/* read views are denser than the editor (no add-item row or controls per folder),
   so the inter-folder gap is a step tighter here (space-6, vs the editor's space-7)
   — the list scans as one block instead of drifting apart. */
.view__folders {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.view__ungrouped {
  margin-bottom: var(--space-1);
}
.view--missing {
  padding-block: var(--space-9);
  align-items: flex-start;
}
</style>
