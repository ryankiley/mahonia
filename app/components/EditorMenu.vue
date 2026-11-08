<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Bug02Icon, CopyPlusIcon, Delete02Icon, FileImportIcon, InformationCircleIcon, KeyboardIcon, LegalDocument01Icon, RemoveCircleIcon, UserAddIcon } from "@hugeicons/core-free-icons";

// The editor's ⋯ menu — the list of actions, NOT the button that opens it. The
// trigger stays in the toolbar (GearEditor), where it is one glyph on the first
// load; everything behind it lives here, in a chunk fetched when the pointer first
// reaches the button (GearEditor's `warmMenu`) or, failing that, on the first tap —
// ~5 KB brotli over five files, one round trip. The round trip comes BEFORE the
// enter transition, not under it: an async component resolves, then mounts, then
// its <Transition appear> plays, which is why the hover warm-up exists. The service
// worker precaches the chunk for every visit after — the same contract the sharing
// panel beside it and every dialog in the editor already have.
//
// The split is the bundle ratchet's own rule — nothing that only runs on one
// interaction belongs on the load before it — applied to a surface that had
// escaped it: the rows below carry their glyphs and the two rows of the foot, every
// byte of it on
// the editor's first load for a menu most visits never open. Priced the way the
// lazy checkbox in scripts/bundle-budget-ledger.md was, and it comes out the other
// way: a chunk boundary costs ~0.3 KB, this body is ten times that (measured: the
// first load 151.1 → 147.8 KB brotli with this split alone).
//
// State lives with the caller — the parent owns `open` (its dismiss contract, its
// mutual exclusion with the sharing menu, the tooltip that stands down) and every
// action is an emit, so the rows here are a table and nothing else: a row is one
// entry, not a hand-written <li> plus a case in a dispatch switch (the argument
// ReadonlyMenu already makes for the read views' twin of this menu).
const props = defineProps<{
  open: boolean;
  /** the first-run screen: nothing to duplicate yet, so that row stands down */
  firstRun: boolean;
  /** a list with a share code — the foot only ends a list that exists */
  saved: boolean;
  /** opened by a claimed code rather than an edit link: Forget is a device act, and
   *  a claimed open has no registry row to drop */
  openedByCode: boolean;
}>();

/** the rows' events — the table below names one per row, and the foot two more */
type MenuEvent = "people" | "duplicate" | "import" | "shortcuts" | "feedback";
type FootEvent = "forget" | "delete";
// call signatures rather than the object form, so that one overload takes a row's
// event as the UNION the table stores — `emit(a.event)` needs that; the object form
// types each name as its own overload and a union matches none of them
const emit = defineEmits<{
  (e: "close"): void;
  (e: MenuEvent | FootEvent): void;
}>();

// NO EXPORT HERE. It was a fold-out in this menu, a glyph away from the links, so the
// two ways of sending a list sat on two surfaces. It lives in the sharing panel now,
// on a tab beside the links, under a card that offers the link first.

// EVERY ROW LEADS WITH A GLYPH. It was words alone until the foot grew two rows that
// needed marks to tell them apart, which left the menu looking like two kinds of list
// stacked on each other.
//
// Import keeps the mirror of the sharing panel's Export mark (FileImport against
// FileExport): the same door in two directions, now on two surfaces, and the glyphs
// should say so before the words do.
// `hidden` keeps an action out of the menu while pressing it would do nothing worth
// doing: an unsaved, empty draft has nothing to duplicate, and a row that makes an
// empty copy is worse than no row (inert controls are absent, not dimmed).
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
  // NOT a clipboard mark, however well one would fit the word "copy". The sharing
  // panel's copies are genuine clipboard writes, and so is the Copy01 pair of sheets
  // that ListHead puts on its Copy button — this row is the odd
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
];
// Help and site destinations live together, away from list operations and the
// destructive pair. The editor has no footer; the sticky toolbar keeps them in reach.
// About and Legal sit beside them in the template — links, not events, since they
// go somewhere rather than do something to the list.
const SITE_ACTIONS: MenuAction[] = [
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
  <!-- `appear`: on a tap with no hover before it, this component is Lazy-mounted on
       the first open (already open), so without it the first reveal would snap where
       every later one eases — the same reason BaseModal carries it. -->
  <Transition name="menu" appear>
    <MenuList v-if="open" class="editor__actions" aria-label="More actions">
      <!-- Close BEFORE the action runs, matching the old dispatch order. -->
      <li v-for="a in menuActions" :key="a.label" role="none">
        <button type="button" data-row role="menuitem" class="menu__item" @click="act(a.event)">
          <HugeiconsIcon :icon="a.icon" :size="16" :stroke-width="2" aria-hidden="true" />
          {{ a.label }}
        </button>
      </li>
      <!-- The site foot: help, then the two pages the editor's footer used to carry
           before it had none (main #376). Ruled off from the list operations above
           by the shared .menu__foot, and from the destructive pair below by the next. -->
      <li role="none" class="menu__foot">
        <button
          v-for="a in SITE_ACTIONS"
          :key="a.label"
          type="button"
          data-row
          role="menuitem"
          class="menu__item"
          @click="act(a.event)"
        >
          <HugeiconsIcon :icon="a.icon" :size="16" :stroke-width="2" aria-hidden="true" />
          {{ a.label }}
        </button>
        <NuxtLink to="/about" data-row role="menuitem" class="menu__item" @click="emit('close')">
          <HugeiconsIcon :icon="InformationCircleIcon" :size="16" :stroke-width="2" aria-hidden="true" />
          About
        </NuxtLink>
        <NuxtLink to="/legal" data-row role="menuitem" class="menu__item" @click="emit('close')">
          <HugeiconsIcon :icon="LegalDocument01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
          Legal
        </NuxtLink>
      </li>
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
          <HugeiconsIcon :icon="RemoveCircleIcon" :size="16" :stroke-width="2" aria-hidden="true" />
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
          <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
          Delete this list
        </button>
      </li>
    </MenuList>
  </Transition>
</template>

<style scoped lang="scss">
/* A short phone can't show the whole menu. Keep all links and actions reachable. */
.editor__actions {
  max-height: calc(100svh - var(--space-9));
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* The shared .menu__foot (controls.scss) separates list, site, and destructive
   actions. Its rule spans the same width as the travelling plate. */
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
