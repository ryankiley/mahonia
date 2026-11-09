<script setup lang="ts">
import type { IconNode } from "~/utils/hugeicon";
import type { GearGlyph } from "~~/shared/gearGlyph";

// Pick a piece's icon from a popover over the thing you pressed — the row's icon on
// /gear, the Icon box in the edit dialog. It used to be a grid unfolded inside the
// dialog, so changing a row's icon meant opening the whole dialog for one tap.
//
// The TRIGGER is the caller's (a slot), because the two look nothing alike and a
// caller's scoped styles can't reach a button this component renders (OptionMenu has
// the long version of why). The slot gets what the button needs: `open`, `toggle`,
// and the aria attributes, so they can't drift from the card they describe.
//
// The card is GearIconCard, mounted the first time it opens: until then a row holds a
// trigger and a flag. Forty-odd glyphs are a grid to look over, not a list to read,
// so it is a card of cells rather than a MenuList, "Match the gear type" first.
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
// the card mounts closed and THEN opens, so its watchers (placement, dismissal) see
// the open happen rather than starting already open
const mounted = ref(false);
const rootRef = useTemplateRef<HTMLElement>("rootRef");
const id = useId();

function toggle() {
  if (mounted.value) return void (open.value = !open.value);
  mounted.value = true;
  nextTick(() => (open.value = true));
}
// back to the button that opened it, so a keyboard user isn't dropped on the page
// (Escape does the same, in useMenuDismiss, and leaves a surrounding dialog open)
function pick(glyph: GearGlyph | null) {
  open.value = false;
  rootRef.value?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  if (glyph !== props.modelValue) emit("update:modelValue", glyph);
}

const triggerAttrs = computed(() => ({
  "aria-haspopup": "dialog" as const,
  "aria-expanded": open.value,
  "aria-controls": id,
}));
</script>

<template>
  <div ref="rootRef" class="menu iconpick">
    <slot name="trigger" :open="open" :toggle="toggle" :attrs="triggerAttrs" />
    <GearIconCard
      v-if="mounted"
      v-model:open="open"
      :model-value="modelValue"
      :auto="auto"
      :label="label"
      :id="id"
      :root="rootRef"
      @pick="pick"
      @overlay-toggle="(o: boolean) => emit('overlayToggle', o)"
    />
  </div>
</template>
