<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { EllipsisIcon } from "@hugeicons/core-free-icons";

// My Gear's ⋯ actions menu — the same quiet kebab the editor and the read views
// carry, in the one place that didn't have one.
//
// A COMPONENT rather than markup inside gear.vue, matching ListMenu and
// ReadonlyMenu: the popover, the travelling plate and the dismiss rules are three
// things that have to behave identically across the site's menus, and the page is
// long enough already. It holds no logic of its own on purpose — the actions are
// the page's, and it only says which one you picked.
//
// No Export disclosure, unlike the other two. Theirs folds four formats away from
// the items you came for; getting gear in and out is all this menu does, and a fold
// around three rows would be a door in front of a door.
const {
  /** Whether there is gear to download. Import stands alone on an empty vault —
   *  restoring a backup onto a new machine is the case that matters most, and it is
   *  exactly the case with nothing to export. */
  canExport = false,
} = defineProps<{ canExport?: boolean }>();
const emit = defineEmits<{ pick: [action: string]; open: [] }>();

const menuOpen = ref(false);
// the travelling wash shared with every other menu (useMenuPlate)
const { plateRef, listRef, placing, on: plateOn } = useMenuPlate();
const menuRef = useTemplateRef<HTMLElement>("menuRef");
// outside tap, a scroll gesture, or Escape — the editor kebab's own rules
useMenuDismiss(menuOpen, menuRef);

function toggle() {
  menuOpen.value = !menuOpen.value;
  // opening warms the exporter chunk, so pressing a row doesn't wait on a fetch
  if (menuOpen.value) emit("open");
}
function run(action: string) {
  menuOpen.value = false;
  emit("pick", action);
}
</script>

<template>
  <div ref="menuRef" class="menu">
    <button
      type="button"
      class="btn btn--icon btn--ghost menu__btn"
      aria-label="More actions"
      title="More actions"
      aria-haspopup="true"
      :aria-expanded="menuOpen"
      @click="toggle"
    >
      <HugeiconsIcon :icon="EllipsisIcon" :size="16" :stroke-width="2" />
    </button>
    <Transition name="menu">
      <ul v-if="menuOpen" ref="listRef" class="popover menu__list" role="menu" aria-label="More actions" v-on="plateOn">
        <!-- the travelling wash (atoms/controls.scss + useMenuPlate) -->
        <li role="none" aria-hidden="true">
          <span ref="plateRef" class="menu__plate" :class="{ 'is-placing': placing }" />
        </li>
        <!-- Import first: it is the row that works on an empty vault, and on a
             full one it is still the rarer, more deliberate act — the downloads
             below it are the ones you reach for without thinking. -->
        <li role="none">
          <button type="button" data-row role="menuitem" class="menu__item" @click="run('import')">Import gear…</button>
        </li>
        <!-- the same two words the editor's and the read views' export rows use, so
             one action keeps one name wherever you meet it -->
        <template v-if="canExport">
          <li role="none">
            <button type="button" data-row role="menuitem" class="menu__item" @click="run('csv')">Download CSV</button>
          </li>
          <li role="none">
            <button type="button" data-row role="menuitem" class="menu__item" @click="run('json')">Download JSON</button>
          </li>
        </template>
      </ul>
    </Transition>
  </div>
</template>
