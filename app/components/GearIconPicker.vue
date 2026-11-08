<script setup lang="ts">
import { HugeiconsIcon, type IconNode } from "~/utils/hugeicon";
import type { GearGlyph } from "~~/shared/gearGlyph";
import { GEAR_ICON_CHOICES } from "~/utils/gearIcons";

// Pick a piece's icon from a popover over the thing you pressed — the row's icon on
// /gear, the Icon box in the edit dialog. It used to be a grid unfolded inside the
// dialog, so changing a row's icon meant opening the whole dialog for one tap.
//
// The TRIGGER is the caller's (a slot), because the two look nothing alike and a
// caller's scoped styles can't reach a button this component renders (OptionMenu has
// the long version of why). The slot gets what the button needs: `open`, `toggle`,
// and the aria attributes, so they can't drift from the card they describe.
//
// Forty-odd glyphs are a grid to look over, not a list to read, so this is a card of
// cells rather than a MenuList. "Match the gear type" leads, since going back to the
// type's icon is the one choice that isn't a picture.
const props = defineProps<{
  /** the icon picked by hand; null when the gear type decides */
  modelValue: GearGlyph | null;
  /** what "Match the gear type" would draw: the type's own icon, or null */
  auto: IconNode | null;
  /** the card's accessible name, e.g. "Icon for Zpacks Duplex" */
  label: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [glyph: GearGlyph | null];
  /** opened or closed — a section's body lifts its clip while the card is up */
  overlayToggle: [open: boolean];
}>();

const open = ref(false);
const rootRef = useTemplateRef<HTMLElement>("rootRef");
const card = useTemplateRef<HTMLElement>("card");
const id = useId();
// measured per open: a row near the floor opens upward, and inside a dialog the card
// fits the dialog's own scroll box and scrolls when neither side has room
const { atStart, above, maxHeight, place } = useMenuPlacement(card, { within: true });

// the same lift contract OptionMenu keeps: on at open, off when the leave transition ENDS
let lifted = false;
function setLift(v: boolean) {
  if (lifted === v) return;
  lifted = v;
  emit("overlayToggle", v);
}
onBeforeUnmount(() => setLift(false));

watch(open, (o) => {
  if (!o) return;
  setLift(true);
  nextTick(() => {
    place();
    // onto the one you have, so the keyboard starts where you are
    card.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  });
});
useMenuDismiss(open, rootRef);

function toggle() {
  open.value = !open.value;
}
// back to the button that opened it, so a keyboard user isn't dropped on the page
function refocus() {
  rootRef.value?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
}
function pick(glyph: GearGlyph | null) {
  open.value = false;
  refocus();
  if (glyph !== props.modelValue) emit("update:modelValue", glyph);
}
// Escape inside the card closes the card and nothing else: stopped here, before the
// edit dialog around it (BaseModal listens on the window) reads it as "close me too"
function onEscape(e: KeyboardEvent) {
  if (!open.value) return;
  e.stopPropagation();
  open.value = false;
  refocus();
}

const triggerAttrs = computed(() => ({
  "aria-haspopup": "dialog" as const,
  "aria-expanded": open.value,
  "aria-controls": id,
}));
</script>

<template>
  <div ref="rootRef" class="menu iconpick" @keydown.esc="onEscape">
    <slot name="trigger" :open="open" :toggle="toggle" :attrs="triggerAttrs" />
    <Transition name="menu" @after-leave="setLift(false)">
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
        <button type="button" class="iconpick__auto" :aria-pressed="modelValue === null" @click="pick(null)">
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
            @click="pick(c.glyph)"
          >
            <HugeiconsIcon :icon="c.icon" :size="20" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* eight cells a line (six on a phone), so forty-odd icons are six short rows */
.iconpick__card {
  --iconpick-cell: 2.5rem;
  width: calc(8 * var(--iconpick-cell) + 7 * var(--space-1) + 2 * var(--space-2));
  max-width: calc(100vw - 2 * var(--space-4));
  padding: var(--space-2);
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
  padding: 0;
  border: 0;
  border-radius: var(--popover-item-radius);
  background: none;
  color: var(--ink-2);
  font: inherit;
  cursor: pointer;
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
  padding-inline: calc((var(--iconpick-cell) - 20px) / 2);
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
.iconpick__cell:active,
.iconpick__auto:active {
  opacity: 0.7;
}
</style>
