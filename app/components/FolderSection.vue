<script setup lang="ts">
import { ArrowDown10, ArrowDownAZ, ArrowDownUp, ArrowUp01, ChevronDown, GripVertical, Trash2 } from "@lucide/vue";
import type { Folder, FolderSort, Item, ListSnapshot } from "~~/shared/types";
import { bySortOrder } from "~~/shared/weights";

// The editor's folder — editable by default, a checklist in packing mode. The
// share views (/s + /l) render ReadonlyFolderSection instead, so this component
// (and the editor graph it pulls in) never ships to a read-only page.
//
// `items` is this folder's items, pre-grouped + sorted by the parent (one
// groupItemsByFolder pass per snapshot) — so an edit anywhere in the list
// doesn't make every folder re-filter the whole item array. `childrenByParent`
// is the same idea for nested rows (one groupItemsByParent pass), threaded
// through to each ItemRow.
const props = withDefaults(
  defineProps<{
    list: ListSnapshot;
    folder: Folder;
    items: Item[];
    childrenByParent: Map<string, Item[]>;
    packed?: boolean;
  }>(),
  { packed: false },
);
const c = useGearList();

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
// while an item is being dragged, the source folder's body must let the lifted row
// translate out of its bounds — so the collapse clip (overflow:hidden) is lifted for
// the duration. A collapse animation never runs mid-drag, so dropping the clip is safe.
const anyItemDrag = computed(() => dnd.dragId.value != null);

// a row's floating overlay (the name-autocomplete dropdown, or the mobile ⋯ actions
// menu) is absolute and can extend past the folder's bottom, which the collapse clip
// (overflow:hidden) would crop. Count how many are open and lift the clip while any is
// (same idea as the drag-pass lift).
const overlayCount = ref(0);
function onOverlayToggle(open: boolean) {
  overlayCount.value = Math.max(0, overlayCount.value + (open ? 1 : -1));
}

// per-folder "sort by": manual (drag order) is the default; name/weight are derived
// views the parent's groupItemsByFolder recomputes each render, so they stay sorted
// as items change. The control's glyph reflects the active mode (and lights up when
// it's not manual, so a sorted folder is legible at a glance without opening it).
// Glyphs read as a matched "sort key" family: A–Z for the name sort, digits for the
// numeric (weight) sorts; the weight arrow flips (down = heaviest/descending, up =
// lightest/ascending) so the two weight modes are distinguishable at 16px, where the
// digit order alone (1-0 vs 0-1) isn't.
const SORT_META: Record<FolderSort, { label: string; icon: typeof ArrowDownUp }> = {
  manual: { label: "Manual order", icon: ArrowDownUp },
  name: { label: "Name (A–Z)", icon: ArrowDownAZ },
  heaviest: { label: "Heaviest first", icon: ArrowDown10 },
  lightest: { label: "Lightest first", icon: ArrowUp01 },
};
const SORT_ORDER: FolderSort[] = ["manual", "name", "heaviest", "lightest"];
const sortBy = computed<FolderSort>(() => props.folder.sortBy ?? "manual");
const isSorted = computed(() => sortBy.value !== "manual");
const sortIcon = computed(() => SORT_META[sortBy.value].icon);
function onSort(e: Event) {
  c.updateFolder(props.folder.id, { sortBy: (e.target as HTMLSelectElement).value as FolderSort });
}

// drag-to-reorder folders via the grip handle (a drop line shows where it lands)
const fdnd = useFolderDnd();
const isFolderDragging = computed(() => fdnd.dragId.value === props.folder.id);
const isDropBefore = computed(
  () => fdnd.dragId.value != null && fdnd.drop.value?.targetId === props.folder.id && fdnd.drop.value.before === true,
);
const isDropAfter = computed(
  () => fdnd.dragId.value != null && fdnd.drop.value?.targetId === props.folder.id && fdnd.drop.value?.before === false,
);
// keyboard path for the reorder grip (its label promises reordering, but a drag
// needs a pointer): ArrowUp/Down move the folder one slot, through the same
// moveFolderBefore commit a drop uses — persistence + reindexing come for free
function onGripKey(e: KeyboardEvent) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  const folders = [...props.list.folders].sort(bySortOrder);
  const i = folders.findIndex((f) => f.id === props.folder.id);
  if (i < 0) return;
  const neighbor = folders[e.key === "ArrowUp" ? i - 1 : i + 1];
  if (neighbor) c.moveFolderBefore(props.folder.id, neighbor.id, e.key === "ArrowUp");
  // the reorder re-inserts this folder's DOM node, blurring the grip — re-focus it
  // so repeat presses work (the section is keyed by id, so the ref persists)
  const grip = e.currentTarget as HTMLElement;
  nextTick(() => grip.focus());
}

// "Add an item" drops a real, empty row into the folder (with every control a
// normal row has) and focuses it — you just start typing. Catalog autocomplete +
// water volumes still work in the row's own name field; an abandoned empty row
// removes itself.
function addBlank() {
  c.addBlankItem(props.folder.id);
}

// collapse: the chevron shows/hides the folder body, persisted per folder id so a
// collapsed folder stays collapsed across reloads (pure UI state, never sent to the
// server). The read-only views keep their own local-only collapse (see
// ReadonlyFolderSection) so the owner's state can't bleed into a shared link.
const COLLAPSE_KEY = `gear.fold.${props.folder.id}`;
const collapsed = ref(false);
onMounted(() => {
  try {
    collapsed.value = localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    /* private mode / no storage — default expanded */
  }
});
function toggleCollapsed() {
  collapsed.value = !collapsed.value;
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
    :data-sort="sortBy"
    :data-collapsed="collapsed || null"
    :class="{ 'folder--dragging': isFolderDragging, 'folder--drop-before': isDropBefore, 'folder--drop-after': isDropAfter }"
  >
    <header class="folder__head" :class="{ 'folder__head--packed': packed }">
      <div class="folder__title">
        <input
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
          <ChevronDown class="folder__chev" :class="{ 'is-collapsed': collapsed }" :size="20" :stroke-width="2" />
        </button>
      </div>
      <!-- trailing actions read left→right: delete · sort · reorder-grip (grip stays
           flush at the edge, matching the item rows) -->
      <div v-if="!packed" class="folder__actions">
        <button
          class="btn btn--icon btn--ghost folder__del"
          title="Remove folder"
          aria-label="Remove folder"
          @click="c.removeFolder(folder.id)"
        >
          <Trash2 :size="16" />
        </button>
        <div class="folder__sortwrap" :class="{ 'is-active': isSorted }">
          <component :is="sortIcon" class="folder__sorticon" :size="16" :stroke-width="2" aria-hidden="true" />
          <select
            class="folder__sortsel"
            :value="sortBy"
            :title="`Sort items — ${SORT_META[sortBy].label}`"
            :aria-label="`Sort items in ${folder.name || 'folder'}`"
            @change="onSort"
          >
            <option v-for="key in SORT_ORDER" :key="key" :value="key">{{ SORT_META[key].label }}</option>
          </select>
        </div>
        <!-- drag via pointerdown; arrow keys give the focused grip the reordering
             its label promises (a drag needs a pointer) -->
        <button
          class="btn btn--icon btn--ghost folder__grip"
          title="Drag to reorder folder"
          :aria-label="`Reorder ${folder.name || 'folder'}`"
          @pointerdown="fdnd.start(folder.id, $event)"
          @keydown="onGripKey"
        >
          <GripVertical :size="16" />
        </button>
      </div>
    </header>

    <!-- collapsible body: a grid whose single row animates 1fr↔0fr (slide) while the
         inner clips — works on Safari, unlike height:auto/interpolate-size which is
         Chromium-only. The chevron rotates in sync. -->
    <div class="folder__body">
      <div class="folder__bodyinner" :class="{ 'is-dragpass': anyItemDrag && !collapsed, 'is-overlay-open': overlayCount > 0 }">
        <TransitionGroup name="item" tag="div" class="folder__items">
          <!-- prev-id is the DISPLAY-order predecessor (items is already in this
               folder's sort order) — it drives each row's indent affordance -->
          <ItemRow
            v-for="(it, i) in items"
            :key="it.id"
            :list="list"
            :item="it"
            :children-by-parent="childrenByParent"
            :prev-id="items[i - 1]?.id ?? null"
            :packed="packed"
            @overlay-toggle="onOverlayToggle"
          />
        </TransitionGroup>

        <div v-if="isAppendTarget" class="folder__droptail" aria-hidden="true" />

        <div v-if="!packed" class="folder__add" :class="{ 'folder__add--first': !items.length }">
          <button type="button" class="folder__addbtn" @click="addBlank">Add an item</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
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
.folder__head--packed {
  grid-template-columns: var(--item-cols-pack);
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
/* the collapse chevron button (base + coarse-pointer tap target) is the shared
   folder atom — atoms/folder.scss. The editor's only extra: the ChevronDown glyph
   sits ~5px inside its own box (the `v` occupies the middle of a 20px viewbox), so
   a small negative margin trims that dead space so it optically hugs the name.
   Safe only because .folder__name hugs its text (field-sizing:content) — the input
   no longer adds variable slack per name. */
.folder__collapse {
  margin-left: -1px;
}
/* the collapse machinery (.folder__body 1fr↔0fr, .folder__bodyinner clip + fade,
   the .folder__chev rotate) is the shared folder atom — atoms/folder.scss */
.folder__bodyinner {
  /* the collapse clip (overflow:hidden, from the atom) clips BOTH axes, but the row
     grips sit flush at the content edge and overshoot ~5px into the gutter — so they
     were getting cropped. Push the clip box's right edge out into the gutter: margin +
     padding cancel, so content alignment is unchanged, and the collapse's vertical
     clip is untouched. */
  margin-right: calc(-1 * var(--space-3));
  padding-right: var(--space-3);
}
/* the clip is lifted mid-drag so a lifted row can translate out of its source folder
   (a collapse animation never runs mid-drag, so dropping it is safe) */
.folder__bodyinner.is-dragpass {
  overflow: visible;
}
/* lift the collapse clip while a row's floating overlay is open (name autocomplete,
   or the mobile ⋯ menu), so its dropdown (absolute, opens below) isn't cropped when
   the row sits at the folder's bottom */
.folder__bodyinner.is-overlay-open {
  overflow: visible;
}
/* size to the typed text so the chevron hugs the name (not the full column) — the
   cap/truncation + name type come from the shared folder atom. min-width is a small
   floor ONLY so a *cleared* name stays clickable (folders are always created with a
   name) — 4ch floored the box wider than short names like "Pack", stranding the
   chevron a variable distance from the text; 2ch lets every real name hug tightly. */
.folder__name {
  width: auto;
  field-sizing: content;
  min-width: 2ch;
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
/* sort control — a quiet glyph (the active mode's arrow) with a transparent native
   <select> laid over it for the picker + full keyboard access, matching the item
   rows' classification selector. Sized like the icon buttons beside it so the
   three-glyph cluster (sort · remove · grip) lines up with the item actions below. */
.folder__sortwrap {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  width: var(--icon-btn);
  min-height: var(--icon-btn);
  color: var(--ink-3);
  transition: color var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.folder__sortwrap:hover {
  color: var(--ink);
}
/* a non-manual sort keeps the glyph lit (like the note button when a note exists),
   so a sorted folder reads as sorted at a glance — even collapsed */
.folder__sortwrap.is-active {
  color: var(--ink-2);
}
.folder__sortwrap.is-active:hover {
  color: var(--ink);
}
.folder__sorticon {
  pointer-events: none;
}
.folder__sortsel {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
}
/* touch: .btn--icon grows to a --tap (44px) target on coarse pointers (controls.scss),
   so the sort control has to match — left at its desktop --icon-btn width, its box is
   12px narrower than the delete/grip beside it, which shoves the folder's delete out of
   line with the item rows' delete below. Match the width AND height (the overlaid
   select is the actual tap target, and the sibling buttons already set the cluster
   height on wide touch viewports; the ≤$bp-stack block later re-squashes phones) and
   bump the glyph like the sibling .btn--icon svg, so the cluster lines up column-for-column. */
@media (pointer: coarse) {
  .folder__sortwrap {
    width: var(--tap);
    min-height: var(--tap);
  }
  .folder__sorticon {
    width: var(--icon-touch);
    height: var(--icon-touch);
  }
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

/* desktop (mouse): clean header at rest — the remove control (and the sort control
   while it's on the default Manual) fade in on hover or focus; the reorder grip stays
   visible always, and a folder on a NON-default sort keeps its lit glyph so the state
   is legible without hovering. Touch (hover: none) keeps everything visible. */
@media (hover: hover) {
  .folder__del,
  .folder__sortwrap:not(.is-active) {
    opacity: 0;
    /* standing compositing layer so Safari doesn't re-snap the glyph ~1px when it
       makes a layer for the first hover fade (same quirk handled on .folder__chev) */
    will-change: opacity;
  }
  .folder__head:hover .folder__del,
  .folder__head:focus-within .folder__del,
  .folder__head:hover .folder__sortwrap,
  .folder__head:focus-within .folder__sortwrap {
    opacity: 1;
  }
}

@media (max-width: $bp-stack) {
  .folder__head {
    grid-template-columns: 1fr auto;
  }
  /* keep packing mode matching the checklist COLUMNS so the folder total stays aligned
     with item weights on mobile too (the checklist ROW itself restacks to
     `auto auto 1fr` here — the header keeps the desktop columns and just needs the
     same right-hand weight track) */
  .folder__head--packed {
    grid-template-columns: var(--item-cols-pack);
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
  .folder__actions {
    grid-column: auto;
  }
  /* the 44px touch tap targets keep their size but overflow the (shorter) 36px
     title field via negative margins — otherwise they inflate the editing header
     and, with baseline alignment, push the folder name down. Packing mode has no
     actions, so without this the title jumps vertically when toggling modes.
     (mirrors the item rows' .item__actions treatment) */
  .folder__actions .btn--icon,
  .folder__sortwrap {
    min-height: 0;
    height: var(--tap);
    margin-block: var(--tap-pull);
  }
  /* the add button's compact mobile metrics ride along with the shared atom
     (atoms/item.scss), so this row and a nested group's stay in step */
}
/* the item rule-line rhythm (.folder__items > *) and the mobile name/row
   tightening are the shared folder atom — atoms/folder.scss */
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
