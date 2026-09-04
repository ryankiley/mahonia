<script setup lang="ts">
import type { Folder, Item, ListSnapshot } from "~~/shared/types";

// A folder's ROWS — the list of ItemRows, the drag droptail, and the "Add an item"
// row — split out of FolderSection as a RENDER BOUNDARY, not as an abstraction.
// FolderSection re-renders on every mode switch (its header genuinely changes: the
// name input's `disabled`, the packing grid) — and while the ItemRows themselves
// bail out of that re-render, the folder still paid for re-creating 154 child
// vnodes, 14 folders' worth, ~50ms a switch. Nothing in HERE renders anything
// mode-shaped (the checklist↔edit swap is CSS off the editor body's data-mode;
// atoms/item.scss), so this component's props are identical before and after a
// switch and Vue skips its subtree entirely. A switch now re-renders fourteen
// headers and zero rows.
//
// A plain wrapper, not a <TransitionGroup>. Only an enter fade was ever declared
// (no move, no leave), but TransitionGroup doesn't know that: it measured
// getBoundingClientRect on every child at every render and again in onUpdated,
// with a forced reflow between — and this component re-renders on every
// itemsByFolder rebuild, twice per "Add an item" (pendingBlankId set, then
// cleared), across all fourteen folders. The fade survives as a CSS animation on
// the rows that are genuinely new (see `fresh`).
//
// Multi-root on purpose — the three blocks land in .folder__bodyinner exactly where
// they always sat, no wrapper element, so the collapse clip and the row rhythm
// (.folder__items > *, atoms/folder.scss) see the same tree as before. The one
// consequence of the fragment: the parent's scope id isn't stamped on these roots,
// which is why the styles that target them moved here with them.
const props = defineProps<{
  list: ListSnapshot;
  folder: Folder;
  /** this folder's items, pre-grouped + sorted by GearEditor — see FolderSection */
  items: Item[];
}>();

// a row's overlay/toast still reaches the folder (which owns the collapse-clip
// lift) and the editor (which owns the toast) — forwarded, not handled
defineEmits<{ overlayToggle: [boolean]; toast: [string] }>();

const c = useGearList();

// Which rows are NEW on this render — the ones TransitionGroup would have given an
// enter transition: an id this folder hasn't rendered before, except on the first
// pass (initial load stays static, as it did without `appear`). A row added here,
// moved in from another folder, un-nested, or restored by undo fades in; a row
// that merely re-sorted does not. One Set diff per items change, in place of a
// layout read per row per render. `seen` only ever grows, and a fresh id stays
// fresh until the next items change — the class lingering is harmless, since a
// CSS animation plays once on arrival and never again while the class holds.
const seen = new Set<string>();
const fresh = shallowRef(new Set<string>());
watch(
  () => props.items,
  (items, prev) => {
    const next = new Set<string>();
    for (const it of items) {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        if (prev) next.add(it.id);
      }
    }
    fresh.value = next;
  },
  { immediate: true },
);

// drag-to-reorder: this folder is a drop zone; show a tail line when an item is
// being dragged to the end of it (no specific row targeted)
const dnd = useItemDnd();
const isAppendTarget = computed(
  () =>
    dnd.dragId.value != null &&
    dnd.drop.value?.folderId === props.folder.id &&
    // a nested sibling's append (parentId set, beforeId null) lands at the end of
    // its GROUP, mid-folder — that spot gets ItemRow's .item-nest__droptail, not
    // this whole-folder tail line
    dnd.drop.value?.parentId == null &&
    dnd.drop.value?.beforeId == null,
);

// "Add an item" drops a real, empty row into the folder (with every control a
// normal row has) and focuses it — you just start typing. Catalog autocomplete +
// water volumes still work in the row's own name field; an abandoned empty row
// removes itself.
function addBlank() {
  c.addBlankItem(props.folder.id);
}
</script>

<template>
  <div class="folder__items">
    <!-- prev-id is the DISPLAY-order predecessor (items is already in this
         folder's sort order) — it drives each row's indent affordance -->
    <!-- No :packed — the row swap is CSS off the editor body's data-mode (see
         atoms/item.scss). As a prop it made every mode switch re-render every
         row; without it the rows bail out of re-renders entirely. -->
    <!-- `is-new` is a STRING, not a class object: a fresh object per render would
         read as a changed attr and re-render every row on every pass here. -->
    <ItemRow
      v-for="(it, i) in items"
      :key="it.id"
      :class="fresh.has(it.id) ? 'is-new' : undefined"
      :list="list"
      :item="it"
      :prev-id="items[i - 1]?.id ?? null"
      @overlay-toggle="$emit('overlayToggle', $event)"
      @toast="$emit('toast', $event)"
    />
  </div>

  <div v-if="isAppendTarget" class="folder__droptail" aria-hidden="true" />

  <!-- CSS-hidden in packing (atoms/folder.scss), so no mount per switch -->
  <div class="folder__add" :class="{ 'folder__add--first': !items.length }">
    <button type="button" class="folder__addbtn" @click="addBlank">Add an item</button>
  </div>
</template>

<style scoped lang="scss">
/* These rules rode along with their elements from FolderSection's scoped block —
   scoped styles match through the scope id stamped on the elements, and these
   elements are stamped with this component's now. */

/* drag-to-reorder: insertion line when dropping at the end of this folder */
.folder__droptail {
  height: var(--space-px);
  background: var(--ink);
  margin: var(--space-1) 0;
}
/* a newly added item fades in where it lands — no vertical slide, so the name you
   just clicked into doesn't jump under the cursor (initial load stays static; see
   `fresh`). The row's root carries this scope id as a child root, so the rule
   reaches it. */
.folder__items > .is-new {
  animation: item-in var(--dur) var(--ease);
}
@keyframes item-in {
  from {
    opacity: 0;
  }
}
/* (no item leave animation: removal goes through useGearList's dispatch(), which
   splices the item out in place before the re-render, so the row is simply gone
   from the next render — nothing holds it to fade. Deletes stay instant by design,
   paired with the undo toast as the real "undo a delete" affordance.) */
/* the add affordance is the next row in the list rhythm: the SAME top padding
   (--space-2, matching .folder__items > *) + the rule line between items, so the
   "Add an item" text lands at the same distance below its divider as an item name
   below theirs — it reads as the next row, not a separate block. (Was --space-3,
   4px too much, which floated it a touch clear of the list.) */
.folder__add {
  border-top: 1px solid var(--line);
  padding-top: var(--space-2);
  margin-top: 0;
}
/* when the folder is EMPTY the add row is the FIRST row, so it drops the rule line —
   a first row never carries a divider under the folder name (same as .folder__items >
   *:first-child), and it keeps the name line-free through the 0→1 add instead of the
   line jumping down under the new item. The --space-2 padding still lands the text
   where a first item would sit. */
.folder__add--first {
  border-top: 0;
}
/* the add button itself (.folder__addbtn) is the shared add-affordance atom, shared with
   a nested group's own add row — atoms/item.scss */
</style>
