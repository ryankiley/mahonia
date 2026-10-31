<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { EllipsisIcon } from "@hugeicons/core-free-icons";

// The ⋯ actions menu's SHELL — the quiet kebab, the popover, the travelling plate and
// the dismiss rules (outside tap, a scroll gesture, Escape) — the three things that
// have to behave identically wherever a menu hangs off a toolbar. The read views' menu
// and My Gear's each carried this by hand; now they bring only their rows, as <li>s in
// the slot, and close the menu through the `close` the slot hands them.
//
// Not the editor's kebab, whose trigger lives in its toolbar and whose body (EditorMenu)
// mounts lazily on a hover; nor the account menu, whose trigger is a Tooltip'd avatar.
// Both have a reason to draw their own shell. OptionMenu is the pick-one cousin.
const { label = "More actions" } = defineProps<{
  /** the trigger's accessible name, its tooltip, and the list's name */
  label?: string;
}>();
/** the moment the menu opens — a parent warms a chunk its rows will need */
const emit = defineEmits<{ open: [] }>();
/** open state, bindable (v-model:open) for a parent that reacts to it; otherwise local */
const open = defineModel<boolean>("open", { default: false });

// the travelling wash shared with every other menu (useMenuPlate)
const { plateRef, listRef, on: plateOn } = useMenuPlate();
const rootRef = useTemplateRef<HTMLElement>("rootRef");
useMenuDismiss(open, rootRef);

function toggle() {
  open.value = !open.value;
  if (open.value) emit("open");
}
const close = () => {
  open.value = false;
};
</script>

<template>
  <div ref="rootRef" class="menu">
    <button
      type="button"
      class="btn btn--icon btn--ghost menu__btn"
      :aria-label="label"
      :title="label"
      aria-haspopup="true"
      :aria-expanded="open"
      @click="toggle"
    >
      <HugeiconsIcon :icon="EllipsisIcon" :size="16" :stroke-width="2" />
    </button>
    <Transition name="menu">
      <ul v-if="open" ref="listRef" class="popover menu__list" role="menu" :aria-label="label" v-on="plateOn">
        <!-- the travelling wash (atoms/controls.scss + useMenuPlate). role="none" so a
             decorative element can't read as a menu item. -->
        <li role="none" aria-hidden="true">
          <span ref="plateRef" class="menu__plate" />
        </li>
        <slot :close="close" />
      </ul>
    </Transition>
  </div>
</template>
