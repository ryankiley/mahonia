<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { CheckIcon, ChevronDownIcon } from "@hugeicons/core-free-icons";
import { mergeSwitcherRows, type SwitcherRow } from "~~/shared/switcher";
import { foldApostrophes } from "~~/shared/tidyText";

// The editor's list switcher: a labelled count in the toolbar that opens a
// filterable menu of the lists this browser holds.
//
// It replaced a page, and that page is now gone. /mine held the lists AND the two
// ways to stop having one; those actions moved to the editor's ⋯ menu (Forget /
// Delete), which left the page holding nothing this doesn't do better, so it retired
// to a 301. Getting BETWEEN lists is a different job with a different frequency from
// acting on one, and routing it through a destination was the thing that never sat
// right. Your lists aren't a library; they're links this browser remembers, which
// is closer to a history than to a filing cabinet.
//
// The one thing that page did better: acting on a list you are NOT in was one click
// there, and is navigate-then-act here. Judged not worth carrying a page for —
// cleanup is rare, and duplicating the ⋯ menu's actions onto these rows would blur
// what a switcher is for.
//
// THE TRIGGER IS A WORD, not a glyph. "4 lists" is discoverable in a way an icon
// isn't, it adds nothing to the toolbar's icon cluster at the other end, and the
// count does double duty — it answers "do I have others?" before you open anything,
// which is the returning-user question in the first place. (The chevron beside it is
// the app's dropdown mark, not the label: the word is what you read, the chevron is
// what says it opens.)
//
// Built on the app's own .menu atom (trigger, .menu__list surface, .menu__item
// rows, the travelling .menu__plate) rather than a private set of styles, so it
// can't drift from the ⋯ and account menus. What's local to this one is the filter
// row and the current-list mark. The FILTER is the idea worth taking from the
// design system's ds-menu: it ships as the list's first row, at row height and row
// inset, so the card's rhythm is unbroken and what you type into is the same voice
// as the list it filters.
const { currentShareCode, hint = false } = defineProps<{
  // The list being edited, so its own row can be marked. From the SNAPSHOT rather
  // than the route: a draft minted this session has its URL rewritten with
  // replaceState and never routes, so route.hash is empty while the list is very
  // much saved and in the registry.
  currentShareCode: string | null;
  /**
   * Show the returning-user pointer — an untouched draft, on a device that has
   * lists. It hangs off THIS control rather than sitting in the column, because a
   * signpost belongs beside the thing it points at; in the middle of the page it
   * told you your lists existed and then left you to find them.
   */
  hint?: boolean;
}>();

const emit = defineEmits<{ "new-list": []; "dismiss-hint": [] }>();

const my = useMyLists();
// The account's half of "your lists" — what makes a list made on the Mac show up
// here on the phone. Signed out it's empty and the menu reads exactly as before.
const claimed = useClaimedLists();

// BY NAME. Recency suits a page you read and leave, which is what the retired /mine
// was — it showed you "2 hours ago" beside each row. This is a switcher, where a
// row's position is muscle memory and a list that reshuffles as you use it is one
// you stop trusting.
// Numeric collation, so "Trip 2" precedes "Trip 10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
// One row per list, from BOTH sources: this browser's registry, plus the lists
// attached to the signed-in account that this browser holds no link for (those
// open via /e/{code} on the session — see shared/switcher.ts for the merge rule).
const all = computed(() =>
  mergeSwitcherRows(my.entries.value, claimed.lists.value).sort((a, b) =>
    collator.compare(savedListTitle(a.title), savedListTitle(b.title)),
  ),
);

// Below two the count would be a lie worth avoiding: "1 list" while you're looking
// at the only one there is. A brand-new visitor never sees this at all.
const enoughToSwitch = computed(() => all.value.length >= 2);
// A menu of five doesn't want a search box; a menu of thirty is unusable without
// one. Same opt-in the kit makes, decided by the data rather than by a prop.
const filterable = computed(() => all.value.length > 6);

const open = ref(false);
const query = ref("");
const rootRef = useTemplateRef<HTMLElement>("rootRef");
const fieldRef = useTemplateRef<HTMLInputElement>("fieldRef");

// Filtered in the v-for rather than by hiding rendered rows. The kit toggles an
// .is-out class because its rows are static markup and it needs one that beats the
// [hidden] UA rule; a v-for over the matches has no such problem.
const shown = computed(() => {
  // apostrophes folded on both sides — titles are stored tidied, so a list called
  // "Ryan’s Timberline" has to answer to the straight apostrophe a keyboard types
  const q = foldApostrophes(query.value.trim().toLowerCase());
  if (!q) return all.value;
  return all.value.filter((e) =>
    foldApostrophes(savedListTitle(e.title).toLowerCase()).includes(q),
  );
});

// Guarded on the prop being set, not just equal: an unsaved draft has no share code
// and neither does a legacy entry, and "" === "" would mark a row at random.
const isCurrent = (e: SwitcherRow) => !!currentShareCode && e.shareCode === currentShareCode;

// The travelling wash — see useMenuPlate for the measurement traps it carries.
// ONE instance for the whole card, footer included. It used to be two: the plate is
// positioned by its row's offsetTop, .lm__rows SCROLLS, and the footer deliberately
// sits outside it (a "New list" that scrolled away with forty lists above it would be
// the wrong control to lose) — so a plate living in the scroller could not reach the
// footer, and a second one covered it instead. That cost the card the only move that
// matters here: the wash BLINKED across the hairline, crossfading between two plates,
// where everywhere else in the app it slides. The composable measures across a
// scroller now, so the plate sits in the panel and travels the whole way.
const { plateRef, listRef, on: plateOn } = useMenuPlate();

function close() {
  open.value = false;
  query.value = "";
}
// same dismiss contract as the ⋯ menu and AccountMenu: the action itself, an
// outside tap, a scroll gesture on mobile, or Escape. The scroll one ignores drags
// INSIDE the card, which matters more here than anywhere else — this is the one menu
// with its own scroller (the list of lists below caps at 15rem).
useMenuDismiss(open, rootRef, close);
watch(open, (o) => {
  if (!o) return;
  // Opening RETIRES the pointer, rather than only hiding it. `v-if="!open"` in the
  // template took it off screen for exactly as long as the menu was up — close the
  // menu and it came back, still pointing at a control you had just used. The prop
  // is owned upstairs and persisted there (gear.intro.dismissed.v1), so telling the
  // parent is the only thing that actually ends it.
  emit("dismiss-hint");
  // Re-read the account's lists on every open — this is the moment a list made on
  // another device has to be here, and the fetch is small, private and no-store.
  // In-place update: whatever was showing stays showing until the answer lands,
  // and signed-out it resolves to empty without a request.
  void claimed.refresh();
  // opened to find something, so the keyboard should already be where you'd type
  if (filterable.value) nextTick(() => fieldRef.value?.focus());
});
</script>

<template>
  <div v-if="enoughToSwitch" ref="rootRef" class="menu lm">
    <button
      type="button"
      class="lm__trigger"
      :class="{ 'is-on': open }"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      {{ all.length }}<span class="lm__word"> packs</span>
      <HugeiconsIcon
        :icon="ChevronDownIcon"
        class="chev"
        :class="{ 'is-open': open }"
        :size="14"
        :stroke-width="2"
        aria-hidden="true"
      />
    </button>

    <!-- The pointer, tethered to the trigger. Opening the menu takes it down: it
         has done its job the moment you've found the control. -->
    <Transition name="menu">
      <div v-if="hint && !open" class="lm__hint" role="status">
        <span>Pick up where you left off</span>
        <button
          type="button"
          class="lm__hintclose"
          aria-label="Dismiss"
          title="Dismiss"
          @click="emit('dismiss-hint')"
        >×</button>
      </div>
    </Transition>

    <Transition name="menu">
      <div
        v-if="open"
        ref="listRef"
        class="popover menu__list lm__panel"
        role="menu"
        aria-label="Your lists"
        v-on="plateOn"
      >
        <!-- the travelling wash, in the PANEL rather than in either row area — the one
             box both of them are measured into (atoms/controls.scss + useMenuPlate) -->
        <span ref="plateRef" class="menu__plate" aria-hidden="true" />
        <div v-if="filterable" class="lm__filter">
          <input
            ref="fieldRef"
            v-model="query"
            type="text"
            class="well lm__field"
            placeholder="Search"
            aria-label="Search lists"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div class="lm__rows">
          <NuxtLink
            v-for="e in shown"
            :key="e.key"
            :to="e.to"
            data-row
            role="menuitem"
            class="menu__item"
            :aria-current="isCurrent(e) ? 'page' : undefined"
            :title="savedListTitle(e.title)"
            @click="close"
          >
            <span class="lm__name t-clip">{{ savedListTitle(e.title) }}</span>
            <!-- on EVERY row, hidden rather than dropped — see the style -->
            <HugeiconsIcon
              :icon="CheckIcon"
              class="menu__check"
              :class="{ 'is-on': isCurrent(e) }"
              :size="14"
              :stroke-width="2"
              aria-hidden="true"
            />
          </NuxtLink>
        </div>

        <p v-if="!shown.length" class="lm__empty">No lists match “{{ query }}”.</p>

        <!-- New list is an ACTION, not one of your lists, so it sits below a
             hairline — the one place in this card a rule earns its keep, because it
             separates two kinds of thing rather than two instances of one. -->
        <div class="menu__foot">
          <button type="button" data-row class="menu__item lm__new" role="menuitem" @click="close(); emit('new-list')">
            New list
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
/* the .menu atom gives the positioning context; this only sets what's local */
.lm {
  flex: none;
}
/* The trigger is the toolbar's own quiet text — a step up from the status line
   beside it, because it's a control and that isn't. */
.lm__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  /* Pull the BOX left by its own inline padding, so the WORD starts on the page
     gutter — flush with the list title and the folder headings below it, which have
     no padding to offset. Without this the label sits 8px inside everything it's
     stacked above, which reads as a wonky first line rather than as a control.
     The hover ground still extends past it, which is what the padding is for.
     Same move as .btn--flush-end at the bar's other end. */
  margin-left: calc(-1 * var(--space-2));
  /* --radius-2, the MODE CHIP's corner (.modebar__opt), not the pill every other
     button in the app wears. This control sits directly above that bar and is read
     with it — two chips in a column, a few pixels apart — so a pill here against a
     rounded rectangle there read as two different kinds of thing when they are the
     same kind: a small labelled chip you press to change what the page is showing.
     The pill is right for a control standing on its own; this one never does. */
  border-radius: var(--radius-2);
  font-size: var(--text-chrome);
  color: var(--ink-2);
  white-space: nowrap;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
/* Split from :hover, not merged with it: .is-on is the OPEN menu's state and has to
   paint on every pointer, while the hover twin paints only where hovering is real
   (see the note on .btn:hover, controls.scss) — otherwise tapping the trigger left
   the fill sitting there after the menu had already closed. */
.lm__trigger.is-on {
  background: var(--paper-2);
  color: var(--ink);
}
@media (hover: hover) and (pointer: fine) {
  .lm__trigger:hover {
    background: var(--paper-2);
    color: var(--ink);
  }
}
/* the app's dropdown mark, and it turns over when the menu is open — it IS the ⋯
   menu's section chevron (.chev, controls.scss), the same atom the sharing
   panel's disclosure wears; the copy that lived here was byte-identical to it */
/* The word STAYS on a phone now. It used to be hidden below $bp-stack, and the comment
   here said why: "It's the topbar that forces this: with three mode segments the tool
   cluster no longer fits 375px." Those segments have left the bar — the view switcher is
   a row in the page now — which gave back ~116px, and the word costs ~30 of it. The
   component's header argues for a word over a glyph; this is that argument no longer
   having to be conceded on the surface where it matters most. */

/* the atom anchors menus to the RIGHT (they hang off trailing-edge icons); this
   one hangs off the bar's leading edge */
.lm__panel {
  right: auto;
  left: 0;
  max-width: 20rem;
  transform-origin: top left;
}

.lm__filter {
  margin-bottom: var(--space-1);
}
/* The GROUND, its placeholder and its focus step are the .well atom (controls.scss) —
   the app's contained input for a floating surface, which is exactly what this is. This
   had its own copy, and the copy carried the bug the atom has now been fixed for: a
   --paper-2 fill on a --surface-float panel measured 1.108:1 in dark and 1.10:1 in
   light, and focusing it swapped in --paper-3, which IS --surface-float in dark, so the
   box vanished outright at 1.000:1 the moment you typed in it.
   Only the geometry is local. The radius agrees with the atom's by construction —
   --popover-item-radius is pinned to the same `--radius-4 - --space-2` step — but it is
   named rather than repeated, because this box is concentric with THIS popover. */
.lm__field {
  width: 100%;
  height: var(--icon-btn);
  padding: 0 var(--space-3);
  border-radius: var(--popover-item-radius);
}

.lm__rows {
  /* Positioned so this box appears in its rows' offsetParent chain, which is how
     useMenuPlate finds the scroll to take off: the plate lives out in the panel
     (it has to reach the footer), so a row in here is measured in a box the plate
     isn't in, and only a positioned scroller puts the two in one space. */
  position: relative;
  display: flex;
  flex-direction: column;
  /* a switcher shouldn't grow past the window; forty lists scroll */
  max-height: 15rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* one line of type and a mark — the weight lives on the list itself, and beside a
   name it competed with the one thing you scan a switcher for. The row layout is
   .menu__item's own (atoms/controls.scss); the name clips with .t-clip (the row is
   already nowrap). */
/* THE ONE YOU'RE IN IS A CHECK, not a ground — .menu__check, the shared mark.
   It was a --paper-3 fill, which put two meanings on one property: the travelling
   plate marks where the POINTER is, and this marked where you ARE. Hovering the
   current row stacked the plate's translucent ink over that fill and composited a
   third, darker tone — so the row you were already on read as more hovered than any
   other row could get, and the two states couldn't be told apart.
   One ground, one meaning: the plate owns every fill in this menu, and "current" is
   said with the same check the vault uses for gear that's already in your list. */
.lm__empty {
  padding: var(--space-2) var(--space-3);
  color: var(--ink-3);
}
.lm__new {
  color: var(--ink-2);
}

/* The hint hangs under the trigger, in the menu's own position space. Not the
   Prompt component: that one is a corner toast or an inline aside, and this is
   neither — it's tethered to a control. */
.lm__hint {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  z-index: var(--z-menu);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-4);
  background: var(--paper-2);
  color: var(--ink-2);
  font-size: var(--text-chrome);
  white-space: nowrap;
}
.lm__hintclose {
  color: var(--ink-3);
  font-size: var(--text-base);
  line-height: 1;
}
.lm__hintclose:hover {
  color: var(--ink);
}
</style>
