<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Bug02Icon, CopyPlusIcon, Delete02Icon, FileExportIcon, FileImportIcon, KeyboardIcon, RemoveCircleIcon, UserAddIcon } from "@hugeicons/core-free-icons";
import type { ListSnapshot } from "~~/shared/types";

// The editor's ⋯ menu — the list of actions, NOT the button that opens it. The
// trigger stays in the toolbar (GearEditor), where it is one glyph on the first
// load; everything behind it lives here, in a chunk fetched on the first open
// (~3 KB brotli, one round trip the enter transition mostly covers; the service
// worker precaches it for every visit after) — the same contract the sharing
// panel beside it and every dialog in the editor already have.
//
// The split is the bundle ratchet's own rule — nothing that only runs on one
// interaction belongs on the load before it — applied to a surface that had
// escaped it: the rows below carry eight glyphs, the export section and its four
// format marks (useListExports), and the two rows of the foot, every byte of it on
// the editor's first load for a menu most visits never open. Priced the way the
// lazy checkbox in scripts/bundle-budget-ledger.md was, and it comes out the other
// way: a chunk boundary costs ~0.3 KB, this body is ten times that (measured: the
// first load 151.1 → 147.8 KB brotli with this split alone).
//
// State lives with the caller — the parent owns `open` (its dismiss contract, its
// mutual exclusion with the share panel, the tooltip that stands down) and every
// action is an emit, so the rows here are a table and nothing else: a row is one
// entry, not a hand-written <li> plus a case in a dispatch switch (the argument
// ReadonlyMenu already makes for the read views' twin of this menu).
const props = defineProps<{
  open: boolean;
  /** the first-run screen: nothing to copy or export yet, so those rows stand down */
  firstRun: boolean;
  /** a list with a share code — the foot only ends a list that exists */
  saved: boolean;
  /** opened by a claimed code rather than an edit link: Forget is a device act, and
   *  a claimed open has no registry row to drop */
  openedByCode: boolean;
  snapshot: ListSnapshot | null;
  /** the READ-ONLY link the plain-text export appends — see the note in GearEditor */
  shareUrl: string;
}>();

/** the rows' events — the table below names one per row, and the foot two more */
type MenuEvent = "people" | "duplicate" | "import" | "shortcuts" | "feedback";
type FootEvent = "forget" | "delete";
// call signatures rather than the object form, so that one overload takes a row's
// event as the UNION the table stores — `emit(a.event)` needs that; the object form
// types each name as its own overload and a union matches none of them
const emit = defineEmits<{
  (e: "close"): void;
  (e: "flash", msg: string): void;
  (e: MenuEvent | FootEvent): void;
}>();

// the travelling wash shared with the other menus (see useMenuPlate). Section
// HEADERS deliberately carry no [data-row] — they open a group rather than doing
// something, so the wash shouldn't claim them as a destination.
const { plateRef, listRef, on: plateOn } = useMenuPlate();

// the four export actions, their chunk warm-up and the ROWS that draw them live in
// useListExports, shared with the read views' ⋯ menu so neither the copy, the error
// handling nor the wording and marks can drift.
const { warmExporters, exportItems } = useListExports(
  () => props.snapshot,
  (msg) => emit("flash", msg),
  () => props.shareUrl,
);

// Export folds into a disclosure — <MenuSection>, shared with the read views' ⋯ menu,
// which owns the header, the reveal and the warm-on-open. The rows are useListExports'.
const exportOpen = ref(false);
// a re-opened menu starts collapsed — the previous session's open section is not a
// preference, and restoring it would put a different item under the cursor
watch(() => props.open, (open) => open || (exportOpen.value = false));

// EVERY ROW LEADS WITH A GLYPH. It was words alone until the foot grew two rows that
// needed marks to tell them apart, which left the menu looking like two kinds of list
// stacked on each other.
//
// The Export items were the exception for one release — bare, on the design system's
// rule that its nested rows carry nothing. That left the one place in the menu where
// the eye had to fall back to reading, so they carry marks now too, one per FORMAT —
// see useListExports.
//
// Import and Export take the mirrored pair deliberately; they are the same door in
// two directions and the glyphs should say so before the words do.
// `hidden` keeps an action out of the menu while pressing it would do nothing worth
// doing: an unsaved, empty draft has nothing to copy or export, and a row that yields
// an empty file is worse than no row (inert controls are absent, not dimmed).
interface MenuAction {
  label: string;
  icon: typeof UserAddIcon;
  event: MenuEvent;
  hidden?: () => boolean;
}
const MENU_ACTIONS: MenuAction[] = [
  // The crew's door BEFORE anyone is named — the chips row carries its own manage
  // button, but that row only exists once someone is on the list, so without an
  // entry here a fresh list has no way in. Short, and not just for the voice: this
  // row's label sets the menu's width once it passes "Duplicate this list", and
  // .menu__item's icon has nothing pinning its size, so a long one squeezed the
  // glyph to sub-pixel while the text took the room. No ellipsis either — it opens
  // a dialog like "Import a list…", but it reads as the plain act it is.
  { label: "Add people", icon: UserAddIcon, event: "people" },
  // …and everything below it makes ANOTHER list: a copy of this one, or one read out
  // of a file. Duplicate/Import are one run for that reason — People leads the menu
  // instead because it is the only entry here that acts on the list you are looking
  // at, and the only one that doesn't navigate away.
  //
  // A blank "Create a list" used to open that run, and it was the same newList() the
  // switcher's footer row calls. Two doors to one act, a toolbar apart. The switcher
  // keeps it: that card is where the lists you already have live, so "and one more"
  // belongs under them rather than filed with import and export. This menu is what
  // you do TO a list; the switcher is which list you're in. (That only works because
  // the switcher now appears at ONE list rather than two — see ListMenu. Below that
  // threshold it wasn't on screen at all, and dropping this row would have stranded a
  // one-pack visitor with no way to start a second.)
  // NOT a clipboard mark, however well one would fit the word "copy". The Export
  // rows below are genuine clipboard writes, and so is the Copy01 pair of sheets
  // that ListHead and SharePanel put on their Copy buttons — this row is the odd
  // one out, minting an independent list and navigating you into it. That is the
  // argument ReadonlyMenu.vue already makes for calling it "Duplicate" and not
  // "Copy"; the glyph is read first, so it has to agree or it spends the label.
  // The plus is what carries it: "another one of these", still legible at 14.
  { label: "Duplicate this list", icon: CopyPlusIcon, event: "duplicate", hidden: () => props.firstRun },
  // Import stays a plain row. It has exactly ONE entry point — the modal, which
  // offers the file and the LighterPack link side by side — and a disclosure holding
  // a single item is a click that reveals nothing you couldn't have been shown. It
  // also forced a label long enough to set the whole menu's width.
  { label: "Import a list…", icon: FileImportIcon, event: "import" },
  // Feedback is reachable from the footer on every page, but the editor is where
  // people actually spend their time and where a long list puts that footer far below
  // the fold — by the time you have something to say about a row, the link is a scroll
  // away. The toolbar is in reach from anywhere in the list.
  // The two entries that are ABOUT using the app rather than acts upon a list, so
  // they close the menu together, after the run that makes lists.
  { label: "Keyboard shortcuts", icon: KeyboardIcon, event: "shortcuts" },
  { label: "Send feedback…", icon: Bug02Icon, event: "feedback" },
];
// what the menu renders: the rows a state hides (Duplicate on the first-run screen)
const menuActions = computed(() => MENU_ACTIONS.filter((a) => !a.hidden?.()));

// Close BEFORE the action runs, matching the dispatch order the rows have always had.
function act(event: MenuEvent | FootEvent) {
  emit("close");
  emit(event);
}
</script>

<template>
  <!-- `appear`: this component is Lazy-mounted on the first open (already open), so
       without it the first reveal would snap where every later one eases — the same
       reason BaseModal carries it. -->
  <Transition name="menu" appear>
    <ul v-if="open" ref="listRef" class="popover menu__list" role="menu" aria-label="More actions" v-on="plateOn">
      <!-- the travelling wash (atoms/controls.scss + useMenuPlate) -->
      <li role="none" aria-hidden="true">
        <span ref="plateRef" class="menu__plate" />
      </li>
      <!-- no "Your lists" here — the footer already carries that link. -->
      <li v-for="a in menuActions" :key="a.label" role="none">
        <button type="button" data-row role="menuitem" class="menu__item" @click="act(a.event)">
          <HugeiconsIcon :icon="a.icon" :size="14" :stroke-width="2" aria-hidden="true" />
          {{ a.label }}
        </button>
      </li>
      <!-- Export folds into <MenuSection>, and stays off the first-run screen
           for the same reason Duplicate does: an unsaved, empty draft has
           nothing to give (a header-only CSV). -->
      <MenuSection
        v-if="!firstRun"
        v-model:open="exportOpen"
        label="Export"
        :icon="FileExportIcon"
        :items="exportItems"
        @opened="warmExporters"
        @pick="emit('close')"
      />
      <!-- Deleting this list, last and under a hairline. Not one of the rows
           above it: everything there makes, copies or moves a list, and this
           one ends it — the same reason ListMenu rules "New list" off its list
           of lists. A rule earns its keep between two KINDS of thing.
           Red, and red at rest rather than only under the pointer — the
           colour is there to be read before you reach for it. It is the
           port of the design system's .ds-menu__item--danger, down to the
           plate washing the row in its own hue (see the style). -->
      <li v-if="saved" role="none" class="menu__foot">
        <!-- Gentler first. The two escalate — off this device, then off the
             internet — and reading them in that order is what makes the
             second one land as the bigger of the pair rather than as
             another way to do the first.
             Forget is a device act — it drops this browser's registry row
             and copy — so a claimed open (which has neither) doesn't offer
             it; Delete works either way in (session or token). -->
        <button
          v-if="!openedByCode"
          type="button"
          data-row
          role="menuitem"
          class="menu__item editor__footact"
          @click="act('forget')"
        >
          <HugeiconsIcon :icon="RemoveCircleIcon" :size="14" :stroke-width="2" aria-hidden="true" />
          Forget this list
        </button>
        <button
          type="button"
          data-row
          data-row-hue
          role="menuitem"
          class="menu__item editor__footact editor__delete"
          @click="act('delete')"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          Delete this list
        </button>
      </li>
    </ul>
  </Transition>
</template>

<style scoped lang="scss">
/* the ⋯ menu's Export section is the shared .menu__sect disclosure (controls.scss),
   which the read views' menu uses too */
/* ...and its FOOT holds the one action that ends the list, ruled off from the rest —
   the shared .menu__foot (controls.scss), which the switcher and the read views' menu
   wear too. The rule sits on the <li> rather than on the row, so it spans the same
   width the travelling plate does (both measure from the popover's padding box)
   instead of the row's own inset. */
/* THE ONE COLOURED ROW IN THE CHROME. It was --ink-3 with the trash glyph doing the
   distinguishing, on the monochrome rule in tokens.scss; it now spends --danger, and
   the token's comment has been widened to say so rather than left asserting a rule
   this breaks.
   The colour is here to be read BEFORE you touch it — a row that only turns red once
   you're on it has already let you arrive. That is the design system's argument for
   .ds-menu__item--danger, and this is its port.
   [data-row-hue] in the markup is what opts this row into the plate washing it in
   its OWN hue rather than the neutral one (useMenuPlate reads the colour straight
   off this declaration), so every other menu in the app is untouched.
   No hover deepen. The wash is the state — moving the ink as well would say two
   things about one event, and there is nowhere darker for red to go that doesn't
   read as a different colour. */
/* the glyph column, and the `flex: none` pinning the icon into it, are .menu__item's
   own now (atoms/controls.scss) — including the section header's, which took its gap
   from the copy that lived here */
/* ...and forgetting stays in plain ink. It is not a lesser action — it takes the
   default row colour, not the quiet one — it just isn't the irreversible one, and
   red is what this menu reserves for that. */
.editor__delete {
  color: var(--danger);
}
</style>
