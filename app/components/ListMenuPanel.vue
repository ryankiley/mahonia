<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { CheckIcon } from "@hugeicons/core-free-icons";
import type { SwitcherRow } from "~~/shared/switcher";
import { foldApostrophes } from "~~/shared/tidyText";

// ListMenu's card: the search, the rows and New list. Its own chunk, loaded when the
// menu first opens (ListMenu warms it on hover or focus): the "Your packs" trigger is
// on every editor's first load, and the card only ever on a click. ListMenu keeps the
// open state, the dismissal and the rows' source; this is only what an open card is.
// A div, not a list: the card holds a search field, a scroller of lists and a footer,
// and the wash sits in the PANEL rather than in either row area, the one box both are
// measured into (MenuList, useMenuPlate). One root, for ListMenu's Transition.
const { rows, currentShareCode, filterable } = defineProps<{
  /** every list, merged from this browser and the account, sorted by name */
  rows: SwitcherRow[];
  currentShareCode: string | null;
  filterable: boolean;
}>();
const emit = defineEmits<{ close: []; "new-list": [] }>();

const query = ref("");
const fieldRef = useTemplateRef<HTMLInputElement>("fieldRef");
// opened to find something, so the keyboard should already be where you'd type
onMounted(() => {
  if (filterable) nextTick(() => fieldRef.value?.focus());
});

// Filtered in the v-for rather than by hiding rendered rows. The kit toggles an
// .is-out class because its rows are static markup and it needs one that beats the
// [hidden] UA rule; a v-for over the matches has no such problem.
const shown = computed(() => {
  // apostrophes folded on both sides — titles are stored tidied, so a list called
  // "Ryan’s Timberline" has to answer to the straight apostrophe a keyboard types
  const q = foldApostrophes(query.value.trim().toLowerCase());
  if (!q) return rows;
  return rows.filter((e) => foldApostrophes(savedListTitle(e.title).toLowerCase()).includes(q));
});

// Guarded on the prop being set, not just equal: an unsaved draft has no share code
// and neither does a legacy entry, and "" === "" would mark a row at random.
const isCurrent = (e: SwitcherRow) => !!currentShareCode && e.shareCode === currentShareCode;
</script>

<template>
  <MenuList tag="div" class="lm__panel" aria-label="Your lists">
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
        @click="emit('close')"
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
         separates two kinds of thing rather than two instances of one.
         It is also the app's ONLY blank-list door now: the editor's ⋯ menu carried
         a "Create a list" twin calling the same handler, and lost it. Which is why
         this card can't wait for a second list to appear. -->
    <div class="menu__foot">
      <button type="button" data-row class="menu__item lm__new" role="menuitem" @click="emit('new-list')">
        New list
      </button>
    </div>
  </MenuList>
</template>

<style scoped lang="scss">
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
  /* the inline inset is the well's own; only the input's block padding goes */
  padding-block: 0;
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
</style>
