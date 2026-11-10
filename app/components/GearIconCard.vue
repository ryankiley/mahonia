<script setup lang="ts">
import { HugeiconsIcon, type IconNode } from "~/utils/hugeicon";
import type { GearGlyph } from "~~/shared/gearGlyph";
import { GEAR_ICON_CHOICES } from "~/utils/gearIcons";

// GearIconPicker's card: the grid, where it hangs, and how it goes away. Its own
// component so a row pays for none of this until its icon is first pressed — /gear
// draws one picker per piece of gear, and a card's placement refs, dismissal watchers
// and transition, times 150 rows, was the page's weight for a popover nobody had opened.
const open = defineModel<boolean>("open", { required: true });
const props = defineProps<{
  modelValue: GearGlyph | null;
  auto: IconNode | null;
  label: string;
  id: string;
  /** the picker's root, trigger included: a press there isn't an outside one */
  root: HTMLElement | null;
}>();
const emit = defineEmits<{ pick: [glyph: GearGlyph | null] }>();

const card = useTemplateRef<HTMLElement>("card");
// measured per open: a row near the floor opens upward, and inside a dialog the card
// fits the dialog's own scroll box and scrolls when neither side has room
const { atStart, above, maxHeight, place } = useMenuPlacement(card, { within: true });

watch(open, (o) => {
  if (!o) return;
  nextTick(() => {
    place();
    // onto the one you have, so the keyboard starts where you are
    card.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  });
});
useMenuDismiss(open, toRef(props, "root"));
</script>

<template>
  <Transition name="menu">
    <div
      v-if="open"
      :id="id"
      ref="card"
      class="popover menu__list iconpick__card"
      :class="{ 'menu__list--start': atStart, 'menu__list--above': above }"
      :style="maxHeight != null ? { maxHeight: `${maxHeight}px` } : undefined"
      role="dialog"
      :aria-label="label"
    >
      <button type="button" class="iconpick__auto" :aria-pressed="modelValue === null" @click="emit('pick', null)">
        <HugeiconsIcon v-if="auto" :icon="auto" :size="20" :stroke-width="2" aria-hidden="true" />
        <span>{{ auto ? "Match the gear type" : "No icon" }}</span>
      </button>
      <div class="iconpick__grid" role="group" aria-label="Icons">
        <button
          v-for="c in GEAR_ICON_CHOICES"
          :key="c.glyph"
          type="button"
          class="iconpick__cell"
          :aria-pressed="modelValue === c.glyph"
          :aria-label="c.label"
          :title="c.label"
          @click="emit('pick', c.glyph)"
        >
          <HugeiconsIcon :icon="c.icon" :size="20" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* eight cells a line (six on a phone), so forty-odd icons are six short rows. The
   2 x --space-2 in the width is the card's padding, which is .menu__list's own
   (atoms/controls.scss). */
.iconpick__card {
  --iconpick-cell: 2.5rem;
  width: calc(8 * var(--iconpick-cell) + 7 * var(--space-1) + 2 * var(--space-2));
  max-width: calc(100vw - 2 * var(--space-4));
  overflow-y: auto;
  overscroll-behavior: contain;
}
@media (max-width: 30rem) {
  .iconpick__card {
    width: calc(6 * var(--iconpick-cell) + 5 * var(--space-1) + 2 * var(--space-2));
  }
}
.iconpick__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, var(--iconpick-cell));
  justify-content: space-between;
  gap: var(--space-1);
}
.iconpick__cell,
.iconpick__auto {
  min-height: var(--iconpick-cell);
  border-radius: var(--popover-item-radius);
  color: var(--ink-2);
}
.iconpick__cell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* its glyph in the first cell's column, so it reads as one more choice of the grid */
.iconpick__auto {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  padding-inline: calc((var(--iconpick-cell) - 20 * var(--tpx)) / 2);
  text-align: start;
}
/* the one you have: the menus' wash under full-strength ink */
.iconpick__cell[aria-pressed="true"],
.iconpick__auto[aria-pressed="true"] {
  background: var(--popover-hover);
  color: var(--ink);
}
@media (hover: hover) and (pointer: fine) {
  .iconpick__cell:hover,
  .iconpick__auto:hover {
    background: var(--popover-hover);
    color: var(--ink);
  }
}
</style>
