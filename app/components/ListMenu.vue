<script setup lang="ts">
import { editLinkPath } from "~~/shared/links";
import type { MyListEntry } from "~~/shared/types";

// The editor's list switcher: a labelled count in the toolbar that opens a
// filterable menu of the lists this browser holds.
//
// It replaces a page. /mine still exists and still owns MANAGING lists (forget on
// this device vs delete for everyone — a confirm dialog needs room to explain the
// difference), but getting BETWEEN lists is a different job with a different
// frequency, and routing it through a destination was the thing that never sat
// right. Your lists aren't a library; they're links this browser remembers, which
// is closer to a history than to a filing cabinet.
//
// THE TRIGGER IS A WORD, not a glyph. "4 lists" is discoverable in a way a chevron
// isn't, it adds nothing to the toolbar's icon cluster at the other end, and the
// count does double duty — it answers "do I have others?" before you open anything,
// which is the returning-user question in the first place.
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

// BY NAME. Recency is right for /mine, which shows you "2 hours ago" and which you
// leave rather than click within; this is a switcher, where a row's position is
// muscle memory and a list that reshuffles as you use it is one you stop trusting.
// Numeric collation, so "Trip 2" precedes "Trip 10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const all = computed(() =>
  [...my.entries.value].sort((a, b) => collator.compare(savedListTitle(a.title), savedListTitle(b.title))),
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
  const q = query.value.trim().toLowerCase();
  if (!q) return all.value;
  return all.value.filter((e) => savedListTitle(e.title).toLowerCase().includes(q));
});

const editPath = (e: MyListEntry) => editLinkPath(e.shareCode, e.editToken);
// Guarded on the prop being set, not just equal: an unsaved draft has no share code
// and neither does a legacy entry, and "" === "" would mark a row at random.
const isCurrent = (e: MyListEntry) => !!currentShareCode && e.shareCode === currentShareCode;

// the travelling wash — see useMenuPlate for the two measurement traps it carries
const { plateRef, listRef, placing, on: plateOn } = useMenuPlate();

function close() {
  open.value = false;
  query.value = "";
}
// same dismiss contract as the ⋯ menu and AccountMenu: the action itself, an
// outside tap, or Escape
onClickOutside(rootRef, close);
useWindowEvent("keydown", (e) => {
  if (e.key === "Escape" && open.value) close();
});
// opened to find something, so the keyboard should already be where you'd type
watch(open, (o) => o && filterable.value && nextTick(() => fieldRef.value?.focus()));
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
      {{ all.length }} lists
      <span class="lm__chev" aria-hidden="true">▾</span>
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
      <div v-if="open" class="popover menu__list lm__panel" role="menu" aria-label="Your lists">
        <div v-if="filterable" class="lm__filter">
          <input
            ref="fieldRef"
            v-model="query"
            type="text"
            class="lm__field"
            placeholder="Filter lists"
            aria-label="Filter lists"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div ref="listRef" class="lm__rows" v-on="plateOn">
          <span ref="plateRef" class="menu__plate" :class="{ 'is-placing': placing }" aria-hidden="true" />
          <NuxtLink
            v-for="e in shown"
            :key="e.editToken"
            :to="editPath(e)"
            data-row
            role="menuitem"
            class="menu__item lm__row"
            :class="{ 'is-current': isCurrent(e) }"
            :aria-current="isCurrent(e) ? 'page' : undefined"
            :title="savedListTitle(e.title)"
            @click="close"
          >{{ savedListTitle(e.title) }}</NuxtLink>
        </div>

        <p v-if="!shown.length" class="lm__empty">No lists match “{{ query }}”.</p>

        <!-- New list is an ACTION, not one of your lists, so it sits below a
             hairline — the one place in this card a rule earns its keep, because it
             separates two kinds of thing rather than two instances of one. -->
        <div class="lm__foot">
          <button type="button" class="menu__item lm__new" role="menuitem" @click="close(); emit('new-list')">
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
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  font: inherit;
  font-size: var(--text-chrome);
  color: var(--ink-2);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.lm__trigger:hover,
.lm__trigger.is-on {
  background: var(--paper-2);
  color: var(--ink);
}
.lm__chev {
  font-size: 0.8em;
  color: var(--ink-3);
}

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
.lm__field {
  width: 100%;
  height: var(--icon-btn);
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--popover-item-radius);
  background: var(--paper-2);
  font: inherit;
  color: var(--ink);
}
.lm__field::placeholder {
  color: var(--ink-3);
}
.lm__field:focus-visible {
  outline: none;
  background: var(--paper-3);
}

.lm__rows {
  position: relative;
  display: flex;
  flex-direction: column;
  /* a switcher shouldn't grow past the window; forty lists scroll */
  max-height: 15rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* one line of type and nothing else — the weight lives on the list itself, and
   beside a name it competed with the one thing you scan a switcher for */
.lm__row {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* The one you're in: a ground, not the travelling wash. That one belongs to the
   pointer, and two washes would argue about which row is "on". */
.lm__row.is-current {
  background: var(--paper-3);
}
.lm__empty {
  padding: var(--space-2) var(--space-3);
  color: var(--ink-3);
}
.lm__foot {
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  border-top: 1px solid var(--line);
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
  border: 0;
  background: none;
  color: var(--ink-3);
  font-size: var(--text-base);
  line-height: 1;
  cursor: pointer;
}
.lm__hintclose:hover {
  color: var(--ink);
}
</style>
