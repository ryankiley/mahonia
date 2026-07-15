<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import type { Folder, Item, ListSnapshot } from "~~/shared/types";

// The share views' folder (/s + /l): static name + collapse + readonly rows.
// Deliberately its OWN component, not FolderSection with a flag — the read pages
// must not pull the editor graph (useGearList, both drag composables, ItemRow's
// autocomplete) into their bundle just to render a static list.
//
// `items` is this folder's items, pre-grouped + sorted by the parent (one
// groupItemsByFolder pass per snapshot).
defineProps<{ list: ListSnapshot; folder: Folder; items: Item[] }>();

// Collapse is local-only here: shared views always START expanded, and a viewer's
// toggle is never persisted — so the owner's collapse state can't bleed into a
// shared link, and a viewer's poking around leaves no trace (folder ids — and thus
// any localStorage keys — are shared across views in the same browser).
const collapsed = ref(false);
</script>

<template>
  <section class="folder" :data-collapsed="collapsed || null">
    <header class="folder__head">
      <div class="folder__title">
        <span class="folder__name">{{ folder.name }}</span>
        <button
          class="folder__collapse"
          :aria-expanded="!collapsed"
          :aria-label="`${collapsed ? 'Expand' : 'Collapse'} ${folder.name || 'folder'}`"
          :title="collapsed ? 'Expand folder' : 'Collapse folder'"
          @click="collapsed = !collapsed"
        >
          <ChevronDown class="folder__chev" :class="{ 'is-collapsed': collapsed }" :size="20" :stroke-width="2" />
        </button>
      </div>
    </header>

    <!-- collapsible body: a grid whose single row animates 1fr↔0fr (slide) while the
         inner clips — works on Safari, unlike height:auto/interpolate-size which is
         Chromium-only. The chevron rotates in sync. -->
    <div class="folder__body">
      <div class="folder__bodyinner">
        <div class="folder__items">
          <ReadonlyItemRow v-for="it in items" :key="it.id" :list="list" :item="it" />
          <p v-if="!items.length" class="t-sm t-muted folder__empty">—</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* de-outlined: no card box — the heading + whitespace separate folders */
.folder {
  position: relative;
  padding: 0;
}
.folder__head {
  display: grid;
  grid-template-columns: var(--item-cols-ro);
  gap: var(--item-gap);
  align-items: baseline;
  margin-bottom: var(--space-1);
}
/* just the name + chevron — no trailing actions in the read view */
.folder__title {
  grid-column: 1 / 4;
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
}
/* collapse chevron — right after the folder name */
.folder__collapse {
  flex: none;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
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
  /* standing layer: the chevron transforms on every toggle, so keep it promoted to
     avoid WebKit re-snapping it ~1px as the compositing layer comes and goes */
  will-change: transform;
}
.folder__chev.is-collapsed {
  transform: rotate(-90deg);
}
/* collapsible body — a grid whose one row animates 1fr↔0fr (cross-browser slide;
   Safari has no interpolate-size, so height:auto↔0 would just snap there). */
.folder__body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--dur) var(--ease);
}
.folder[data-collapsed] .folder__body {
  grid-template-rows: 0fr;
}
.folder__bodyinner {
  min-height: 0;
  overflow: hidden;
  opacity: 1;
  transition: opacity var(--dur) var(--ease);
}
.folder[data-collapsed] .folder__bodyinner {
  opacity: 0;
}
/* truncate long names at the same cap as the editor's folder-name field so the
   collapse chevron hugs the name rather than drifting to the column edge */
.folder__name {
  min-width: 0;
  max-width: min(40ch, 50vw);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
  font-size: var(--text-title);
  letter-spacing: -0.02em;
}
/* rule lines between items — a quiet spec-sheet rhythm; padding here (not on the
   rows) keeps the gap above/below each rule consistent */
.folder__items > * {
  padding-block: var(--space-3);
}
.folder__items > * + * {
  border-top: 1px solid var(--line);
}
.folder__empty {
  color: var(--ink-3);
}

@media (max-width: 720px) {
  /* no trailing actions in the read view — let the title (name + chevron) run
     the WHOLE row, and drop the desktop 50vw cap so the name uses the width the
     grid gives it before ellipsizing (mirrors the editor's mobile treatment) */
  .folder__head {
    grid-template-columns: 1fr;
  }
  .folder__title {
    grid-column: 1 / -1;
  }
  .folder__name {
    max-width: none;
  }
  /* tighten the two-row mobile items so each row reads as one unit, not spaced out */
  .folder__items > * {
    padding-block: var(--space-2);
  }
}
</style>
