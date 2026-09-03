<script setup lang="ts">
import { HugeiconsIcon, type IconNode } from "~/utils/hugeicon";

// One of a row's popover menus. The carrier picker, the nesting actions and the
// mobile ⋯ overflow were this exact shape written three times in ItemRow: a .menu
// root, a quiet icon trigger (aria-haspopup / aria-expanded, mousedown-prevented),
// and a <ul role=menu> popover hung off it, measured on the tick it opens for which
// sides it fits on. The ENTRIES are the caller's — the default slot — so this owns
// only the chrome and the open/close contract, and the three menus can't drift on
// either.
//
// Open state lives in useItemMenu's singleton: ONE open id for the whole list, so
// opening any row's menu closes every other, and there is one set of dismiss
// listeners for all of them rather than a pair per row. Every popover a row can
// raise is namespaced off the row id (`<id>:person`, `<id>:nest`, `<id>:menu` — and
// the row's own `:worn` / `:kcal` dialogs, which stay in ItemRow), which is what
// makes them mutually exclusive for free, on this row or any other, with no
// cross-wiring between them.
const props = defineProps<{
  rowId: string;
  /** the id's namespace under the row — "person", "nest", "menu" */
  kind: string;
  /** the trigger's accessible name, and its tooltip when `tooltip` is on */
  label: string;
  /** the list's accessible name, when it reads differently from the trigger's —
   *  "Who carries this" under a trigger named "Carried by Sam" */
  menuLabel?: string;
  /** the trigger's glyph; the carrier picker draws its own through the `trigger`
   *  slot instead (the assigned carrier's dot, see ItemRow) */
  icon?: IconNode;
  /** show `label` as a hover description too. The ⋯ overflow doesn't: it is
   *  mobile-only, and a phone can't hover. */
  tooltip?: boolean;
  /** the trigger's own classes — the row keys its icon styling and the mobile
   *  hide/show off these */
  triggerClass?: string;
}>();
// the folder lifts its collapse clip while this is open — otherwise a menu opened
// on the folder's last row is cropped at the folder's bottom edge
const emit = defineEmits<{ overlayToggle: [boolean] }>();

const menu = useItemMenu();
const rootRef = useTemplateRef<HTMLElement>("rootRef");
const listRef = useTemplateRef<HTMLElement>("listRef");
// Which sides to hang from, measured per open (useMenuPlacement). Rows are the one
// place the atom's default was reliably wrong: a list is long, so its LAST rows sit
// at the viewport floor, and a menu anchored below them opened off the bottom of
// the screen — 144px past it, measured. One placement per menu; only one of a
// row's menus is ever open (the singleton), so nothing is measured that isn't up.
const { atStart, above, place } = useMenuPlacement(listRef);
const id = computed(() => `${props.rowId}:${props.kind}`);
const isOpen = computed(() => menu.openId.value === id.value);
// measured on the tick the list mounts — it has no size to measure before that
watch(isOpen, (open) => {
  emit("overlayToggle", open);
  if (open) nextTick(place);
});
function toggle() {
  menu.toggle(id.value, rootRef.value);
}
</script>

<template>
  <div ref="rootRef" class="menu">
    <!-- Tooltip wraps the BUTTON, not the root: the popover below is anchored to
         the root, and putting the wrapper around both would re-anchor it to a div
         that only spans the trigger. The accessible name stays on the control
         (aria-label) — the tooltip only adds the visible description. Disabled
         while open (two floating surfaces off one control read as a glitch), and
         outright for a menu that asked for none. -->
    <Tooltip :text="label" preferred-placement="top" :disabled="isOpen || !tooltip">
      <!-- mousedown.prevent: on macOS Safari/Firefox a button does NOT take focus on
           mousedown, so clicking one from a focused input blurs the row
           (relatedTarget null) and a pristine blank row discards itself before the
           click can act. Preventing the default keeps focus where it was; click
           still fires. -->
      <button
        class="btn btn--icon btn--ghost rowmenu__btn"
        :class="triggerClass"
        type="button"
        aria-haspopup="menu"
        :aria-expanded="isOpen"
        :aria-label="label"
        @mousedown.prevent
        @click="toggle"
      >
        <slot name="trigger">
          <HugeiconsIcon v-if="icon" :icon="icon" :size="16" :stroke-width="2" />
        </slot>
      </button>
    </Tooltip>
    <Transition name="menu">
      <ul
        v-if="isOpen"
        ref="listRef"
        class="popover menu__list"
        :class="{ 'menu__list--start': atStart, 'menu__list--above': above }"
        role="menu"
        :aria-label="menuLabel ?? label"
      >
        <slot />
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
/* Quiet at rest (--ink-3), ink under the pointer — the row's own rule for every
   glyph in its trailing cluster (ItemRow's .item__grip family), restated here
   because a scoped rule there can't reach a button rendered in this component.
   The ⋯ trigger also carries .menu__btn (--ink-2, controls.scss); this outranks it
   so it reads at the same weight as the delete + grip it sits between. */
.rowmenu__btn {
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.rowmenu__btn:hover {
  color: var(--ink);
}
</style>
