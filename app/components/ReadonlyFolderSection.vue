<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import type { Folder, Item, ListSnapshot } from "~~/shared/types";

// The share views' folder (/s + /l): static name + collapse + readonly rows.
// Deliberately its OWN component, not FolderSection with a flag — the read pages
// must not pull the editor graph (useGearList, both drag composables, ItemRow's
// autocomplete) into their bundle just to render a static list.
//
// `items` is this folder's items, pre-grouped + sorted by the parent (one
// groupItemsByFolder pass per snapshot); `childrenByParent` is the same idea for
// nested rows (one groupItemsByParent pass), threaded through to each row.
defineProps<{
  list: ListSnapshot;
  folder: Folder;
  items: Item[];
  childrenByParent: Map<string, Item[]>;
}>();

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
          <ReadonlyItemRow v-for="it in items" :key="it.id" :list="list" :item="it" :children-by-parent="childrenByParent" />
          <p v-if="!items.length" class="t-sm t-muted folder__empty">—</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
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
/* the collapse chevron button + its coarse-pointer tap target, the collapse
   machinery (.folder__body 1fr↔0fr, .folder__bodyinner clip + fade, the
   .folder__chev rotate), the name type/truncation cap, and the item rule-line
   rhythm are all the shared folder atom — atoms/folder.scss, one recipe with the
   editor's FolderSection so the two views can't drift */
.folder__name {
  /* a flex child must be allowed to shrink for the atom's ellipsis to engage */
  min-width: 0;
}
.folder__empty {
  color: var(--ink-3);
}

@media (max-width: $bp-stack) {
  /* no trailing actions in the read view — let the title (name + chevron) run
     the WHOLE row (the atom drops the desktop 50vw name cap here) */
  .folder__head {
    grid-template-columns: 1fr;
  }
  .folder__title {
    grid-column: 1 / -1;
  }
}
</style>
