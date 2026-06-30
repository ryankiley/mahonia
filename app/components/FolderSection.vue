<script setup lang="ts">
import { ChevronDown, GripVertical, Trash2 } from "@lucide/vue";
import type { Folder, ListSnapshot } from "~~/shared/types";
import { bySortOrder, itemsInFolder } from "~~/shared/weights";

const props = withDefaults(
  defineProps<{ list: ListSnapshot; folder: Folder; packed?: boolean; readonly?: boolean }>(),
  { packed: false, readonly: false },
);
const c = useGearList();

// drag-to-reorder: this folder is a drop zone; show a tail line when an item is
// being dragged to the end of it (no specific row targeted)
const dnd = useItemDnd();
const isAppendTarget = computed(
  () =>
    dnd.dragId.value != null &&
    dnd.drop.value?.folderId === props.folder.id &&
    dnd.drop.value?.beforeId == null,
);
// while an item is being dragged, the source folder's body must let the lifted row
// translate out of its bounds — so the collapse clip (overflow:hidden) is lifted for
// the duration. A collapse animation never runs mid-drag, so dropping the clip is safe.
const anyItemDrag = computed(() => dnd.dragId.value != null);

// a row's name autocomplete dropdown is absolute and can extend past the folder's
// bottom, which the collapse clip (overflow:hidden) would crop. Count how many rows
// have it open and lift the clip while any is (same idea as the drag-pass lift).
const acOpenCount = ref(0);
function onAcToggle(open: boolean) {
  acOpenCount.value = Math.max(0, acOpenCount.value + (open ? 1 : -1));
}

const items = computed(() => itemsInFolder(props.list.items, props.folder.id).sort(bySortOrder));

// drag-to-reorder folders via the grip handle (a drop line shows where it lands)
const fdnd = useFolderDnd();
const isFolderDragging = computed(() => fdnd.dragId.value === props.folder.id);
const isDropBefore = computed(
  () => fdnd.dragId.value != null && fdnd.drop.value?.targetId === props.folder.id && fdnd.drop.value.before === true,
);
const isDropAfter = computed(
  () => fdnd.dragId.value != null && fdnd.drop.value?.targetId === props.folder.id && fdnd.drop.value?.before === false,
);

// "Add an item" drops a real, empty row into the folder (with every control a
// normal row has) and focuses it — you just start typing. Catalog autocomplete +
// water volumes still work in the row's own name field; an abandoned empty row
// removes itself.
function addBlank() {
  c.addBlankItem(props.folder.id);
}

// collapse: the chevron shows/hides the folder body. In the EDITABLE view it's
// persisted per folder id so a collapsed folder stays collapsed across reloads
// (pure UI state, never sent to the server). The read-only shared views (/s, /l)
// deliberately DON'T read or write this: they always start with every folder open
// so the owner's collapse state can't bleed into a shared link (folder ids — and
// thus the localStorage keys — are shared across views in the same browser). A
// viewer may still collapse locally, but that choice is never persisted.
const COLLAPSE_KEY = `gear.fold.${props.folder.id}`;
const collapsed = ref(false);
onMounted(() => {
  if (props.readonly) return; // shared views always start expanded
  try {
    collapsed.value = localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    /* private mode / no storage — default expanded */
  }
});
function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  if (props.readonly) return; // don't persist/sync collapse from a shared view
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <section
    class="folder"
    :data-folder="folder.id"
    :data-collapsed="collapsed || null"
    :class="{ 'folder--dragging': isFolderDragging, 'folder--drop-before': isDropBefore, 'folder--drop-after': isDropAfter }"
  >
    <header class="folder__head" :class="{ 'folder__head--ro': readonly, 'folder__head--packed': packed }">
      <div class="folder__title">
        <span v-if="readonly" class="folder__name">{{ folder.name }}</span>
        <input
          v-else
          class="field folder__name"
          :value="folder.name"
          :disabled="packed"
          aria-label="Folder name"
          autocorrect="off"
          spellcheck="false"
          @change="c.updateFolder(folder.id, { name: ($event.target as HTMLInputElement).value })"
        />
        <button
          class="folder__collapse"
          :aria-expanded="!collapsed"
          :aria-label="`${collapsed ? 'Expand' : 'Collapse'} ${folder.name || 'folder'}`"
          :title="collapsed ? 'Expand folder' : 'Collapse folder'"
          @click="toggleCollapsed"
        >
          <ChevronDown class="folder__chev" :class="{ 'is-collapsed': collapsed }" :size="18" :stroke-width="2" />
        </button>
      </div>
      <div v-if="!packed && !readonly" class="folder__actions">
        <button
          class="btn btn--icon btn--ghost folder__del"
          title="Remove folder"
          aria-label="Remove folder"
          @click="c.removeFolder(folder.id)"
        >
          <Trash2 :size="16" />
        </button>
        <button
          class="btn btn--icon btn--ghost folder__grip"
          title="Drag to reorder folder"
          :aria-label="`Reorder ${folder.name || 'folder'}`"
          @pointerdown="fdnd.start(folder.id, $event)"
        >
          <GripVertical :size="15" />
        </button>
      </div>
    </header>

    <!-- collapsible body: a grid whose single row animates 1fr↔0fr (slide) while the
         inner clips — works on Safari, unlike height:auto/interpolate-size which is
         Chromium-only. The chevron rotates in sync. -->
    <div class="folder__body">
      <div class="folder__bodyinner" :class="{ 'is-dragpass': anyItemDrag && !collapsed, 'is-acopen': acOpenCount > 0 }">
        <TransitionGroup name="item" tag="div" class="folder__items">
          <ItemRow v-for="it in items" :key="it.id" :list="list" :item="it" :packed="packed" :readonly="readonly" @autocomplete-toggle="onAcToggle" />
          <p v-if="!items.length && readonly" key="empty-ro" class="t-sm t-muted folder__empty">—</p>
        </TransitionGroup>

        <div v-if="isAppendTarget" class="folder__droptail" aria-hidden="true" />

        <div v-if="!packed && !readonly" class="folder__add">
          <button type="button" class="folder__addbtn" @click="addBlank">Add an item</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* de-outlined: no card box — the heading + the colored dot + whitespace separate folders */
.folder {
  position: relative;
  padding: 0;
}
.folder.folder--dragging {
  opacity: 0.4;
}
/* drop line marking where a dragged folder will land (sits in the gap between folders) */
.folder--drop-before::before,
.folder--drop-after::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: var(--space-px);
  background: var(--ink);
  pointer-events: none;
}
.folder--drop-before::before {
  top: calc(-0.5 * var(--space-7));
}
.folder--drop-after::after {
  bottom: calc(-0.5 * var(--space-7));
}
/* same column template as ItemRow so the remove + grip line up with item controls */
.folder__head {
  display: grid;
  grid-template-columns: var(--item-cols);
  gap: var(--item-gap);
  align-items: baseline;
  margin-bottom: var(--space-1);
}
.folder__head--ro {
  grid-template-columns: var(--item-cols-ro);
}
.folder__head--packed {
  grid-template-columns: auto var(--item-cols-ro);
}
/* read view: just the name */
.folder__head--ro .folder__title {
  grid-column: 1 / 4;
}
/* the name sits flush at the page edge (aligned with item names); the collapse
   chevron sits just to its right; remove + grip are the trailing columns */
.folder__title {
  grid-column: 1 / 5;
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
   Safari has no interpolate-size, so height:auto↔0 would just snap there). The inner
   needs min-height:0 to collapse below content size + overflow:hidden to clip the
   reveal; that clip is lifted mid-drag (.is-dragpass) so a lifted row can translate
   out of its source folder. */
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
  /* the collapse clip (overflow:hidden) clips BOTH axes, but the row grips sit flush at
     the content edge and overshoot ~5px into the gutter — so they were getting cropped.
     Push the clip box's right edge out into the gutter: margin + padding cancel, so
     content alignment is unchanged, and the collapse's vertical clip is untouched. */
  margin-right: calc(-1 * var(--space-3));
  padding-right: var(--space-3);
}
.folder[data-collapsed] .folder__bodyinner {
  opacity: 0;
}
.folder__bodyinner.is-dragpass {
  overflow: visible;
}
/* lift the collapse clip while a row's name autocomplete is open, so its dropdown
   (absolute, opens below) isn't cropped when the row sits at the folder's bottom */
.folder__bodyinner.is-acopen {
  overflow: visible;
}
/* size to the typed text so the chevron hugs the name (not the full column);
   once it hits the cap (or, on mobile, the row edge) it truncates with an ellipsis
   rather than a hard mid-character cut */
.folder__name {
  width: auto;
  field-sizing: content;
  min-width: 4ch;
  max-width: min(40ch, 50vw);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
  font-size: var(--text-title);
  letter-spacing: -0.02em;
}
/* packing/checklist mode disables the name input (it's read-only there). Browsers
   grey disabled inputs out (UA -webkit-text-fill-color), so pin it back to full ink —
   the folder name should read the same as it does in edit mode. */
.folder__name:disabled {
  color: var(--ink);
  -webkit-text-fill-color: var(--ink);
  opacity: 1;
}
/* remove + grip share the trailing actions cluster — evenly spaced + aligned
   with the item actions cluster below (both end at the grid edge) */
.folder__actions {
  grid-column: 5;
  justify-self: end;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.folder__del,
.folder__grip {
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.folder__del:hover,
.folder__grip:hover {
  color: var(--ink);
}
/* right-align both controls + pull the grip's layout box left so its gap matches
   the item rows below (the flush shift is otherwise invisible to layout) */
.folder__actions .btn--icon {
  justify-content: flex-end;
}
.folder__grip {
  cursor: grab;
  touch-action: none;
  /* reorder dots flush to the right edge — the visible glyph, not just the tap
     target (matches the item rows); the empty overshoot falls into the gutter */
  justify-content: flex-end;
  margin-left: -9px;
}
.folder__grip svg {
  transform: translateX(33.333%);
}
.folder__grip:active {
  cursor: grabbing;
}

/* desktop (mouse): clean header at rest — the remove control fades in on hover or
   focus; the reorder grip stays visible always. Touch (hover: none) keeps both. */
@media (hover: hover) {
  .folder__del {
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .folder__head:hover .folder__del,
  .folder__head:focus-within .folder__del {
    opacity: 1;
  }
}

@media (max-width: 560px) {
  .folder__head {
    grid-template-columns: 1fr auto;
  }
  /* keep packing mode matching the checklist grid so the folder total stays
     aligned with item weights on mobile too */
  .folder__head--packed {
    grid-template-columns: auto var(--item-cols-ro);
  }
  .folder__title {
    grid-column: 1;
  }
  /* checklist/packing mode has no trailing actions, so let the title span the WHOLE
     row — otherwise the empty 1fr data column steals the width and the name
     truncates with room to spare (e.g. "Miscellaneous …") */
  .folder__head--packed .folder__title {
    grid-column: 1 / -1;
  }
  /* on a phone, 50vw strands space before the action icons — let the name run the
     full row (the grid column + chevron bound it) and ellipsize at the edge */
  .folder__name {
    max-width: none;
  }
  .folder__actions {
    grid-column: auto;
  }
  /* the 44px touch tap targets keep their size but overflow the (shorter) 36px
     title field via negative margins — otherwise they inflate the editing header
     and, with baseline alignment, push the folder name down. Packing mode has no
     actions, so without this the title jumps vertically when toggling modes.
     (mirrors the item rows' .item__actions treatment) */
  .folder__actions .btn--icon {
    min-height: 0;
    height: 2.75rem;
    margin-block: -0.65rem;
  }
  /* tighten the two-row mobile items so each row reads as one unit, not spaced out */
  .folder__items > * {
    padding-block: var(--space-2);
  }
}
/* rule lines between items — a quiet spec-sheet rhythm; padding here (not on the
   rows) keeps the gap above/below each rule consistent across all row types */
.folder__items > * {
  padding-block: var(--space-3);
}
.folder__items > * + * {
  border-top: 1px solid var(--line);
}
.folder__empty {
  color: var(--ink-3);
}
/* drag-to-reorder: insertion line when dropping at the end of this folder */
.folder__droptail {
  height: var(--space-px);
  background: var(--ink);
  margin: var(--space-1) 0;
}
/* a newly added item fades in where it lands — no vertical slide, so the name you
   just clicked into doesn't jump under the cursor (initial load stays static) */
.item-enter-active {
  transition: opacity var(--dur) var(--ease);
}
.item-enter-from {
  opacity: 0;
}
/* (no item leave transition: removal goes through useGearList's dispatch(), which
   splices the item out in place before the re-render, so TransitionGroup never holds
   the leaving vnode — a CSS leave can't engage. Deletes stay instant by design, paired
   with the undo toast as the real "undo a delete" affordance.) */
/* the add affordance is the next row in the list rhythm: same top padding +
   border as the rule line between items, so it doesn't read as a separate block */
.folder__add {
  border-top: 1px solid var(--line);
  padding-top: var(--space-3);
  margin-top: 0;
}
/* quiet add affordance — a dim "Add an item" flush with the item names. Shares the
   item name field's box metrics (min-height + vertical centring) so its text lands
   on the same baseline as the names above it, reading as one continuous list */
.folder__addbtn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: var(--space-1) 0;
  background: none;
  border: 0;
  font-size: var(--text-base);
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.folder__addbtn:hover {
  color: var(--ink);
}
</style>
