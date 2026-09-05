<script setup lang="ts">
import { HugeiconsIcon, type IconNode } from "~/utils/hugeicon";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";

// A GROUP OF ROWS INSIDE A ⋯ MENU, folded behind a header that turns over.
//
// Both ⋯ menus want exactly this — the editor's kebab for Export, the read views' for
// the same — and they each drew it by hand. The two copies had converged to the
// character (same .menu__secthead, same glyph, same .menu__sectlabel, same .chev, same
// <Transition name="reveal">, same role="group"), which is the state right before
// drift rather than a state to leave alone; the WHEN had in fact already drifted, and
// that is what this component fixes by owning it (see `open` below).
//
// The header is NOT a menuitem. It opens a group rather than doing anything, so it
// carries aria-expanded and the items stay the menuitems. It does carry [data-row],
// because once a menu has a travelling plate every .menu__item's own :hover is
// switched off (controls.scss) — a header left unmarked lights on neither path and
// reads as the one dead row. The plate finds it through the DOM, so a component
// boundary between it and the <ul> costs nothing (useMenuPlate queries [data-row]).
//
// Every class here is a global atom in atoms/controls.scss, so this file needs no
// styles of its own and no :deep() to reach them.
const props = defineProps<{
  /** the header's word, and the group's accessible name */
  label: string;
  /** the header's mark, in the same glyph column as every row above it */
  icon: IconNode;
  /** the rows, in the order they are drawn — see useListExports' exportItems */
  items: readonly { key?: string; label: string; icon: IconNode; run: () => unknown }[];
}>();

/**
 * Open state, owned by the PARENT, because closing the whole menu has to close this
 * too and only the parent knows that happened. A re-opened menu starts collapsed: the
 * previous session's open section is not a preference, and restoring it would put a
 * different item under the cursor.
 */
const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  /** The section just opened — the moment to warm anything its rows will need.
   *  NOT named `open`: that is the model's own name, so the two collide and the
   *  listener never fires (the parent's @open is swallowed by v-model:open). */
  opened: [];
  /** a row ran; the parent closes the menu around it */
  pick: [];
}>();

function toggle() {
  // The next value is computed ONCE and used for both the write and the test. Reading
  // `open.value` back after assigning it does NOT give you what you just wrote when a
  // parent binds the model: defineModel's getter returns the prop, and the parent has
  // not re-rendered yet — so `if (open.value)` was still reading the old state and the
  // warm fired on CLOSE instead of open, exactly inverted. (Caught by
  // tests/readonlyMenu.nuxt.test.ts, which is the whole reason it asserts on the
  // trigger rather than on the fetch.)
  const next = !open.value;
  open.value = next;
  // Warm on THIS, not on the menu opening. Opening ⋯ to duplicate a list shouldn't pull
  // parsers you never asked for — on the share views that is four chunks fetched for a
  // reader who came for "Copy link" — and opening the group is the first honest signal
  // that one of its rows is about to run. The editor's kebab already worked this way;
  // the read views' menu warmed on every ⋯ open, and that asymmetry is the one thing
  // two hand-written copies of this markup had already let drift.
  if (next) emit("opened");
}

// Close the menu BEFORE the row's own work, matching every plain row in both menus.
function run(item: (typeof props.items)[number]) {
  emit("pick");
  void item.run();
}
</script>

<template>
  <li role="none" class="menu__sect">
    <button
      type="button"
      data-row
      class="menu__item menu__secthead"
      :aria-expanded="open"
      @click="toggle"
    >
      <HugeiconsIcon :icon="icon" :size="14" :stroke-width="2" aria-hidden="true" />
      <!-- the label takes the slack, so the chevron keeps the trailing edge now that a
           glyph holds the leading one -->
      <span class="menu__sectlabel">{{ label }}</span>
      <HugeiconsIcon
        :icon="ChevronDownIcon"
        class="chev"
        :class="{ 'is-open': open }"
        :size="14"
        :stroke-width="2"
        aria-hidden="true"
      />
    </button>
    <!-- Transition + v-if, NOT a class: .reveal is a transition recipe (it has no
         open/closed state of its own and defaults to 1fr), so driving it with a class
         leaves the section permanently expanded and the chevron spinning over nothing.
         v-if also takes the collapsed items out of the tab order, which a height-0 box
         would not. -->
    <Transition name="reveal">
      <div v-if="open" class="reveal">
        <ul class="menu__sectlist" role="group" :aria-label="label">
          <li v-for="item in items" :key="item.key ?? item.label" role="none">
            <button
              type="button"
              data-row
              role="menuitem"
              class="menu__item menu__sectitem"
              @click="run(item)"
            >
              <HugeiconsIcon :icon="item.icon" :size="14" :stroke-width="2" aria-hidden="true" />
              {{ item.label }}
            </button>
          </li>
        </ul>
      </div>
    </Transition>
  </li>
</template>
