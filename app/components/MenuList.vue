<script setup lang="ts">
// THE MENU LIST: the card a menu's rows sit in. The app's anchored menus are this (the
// ⋯ menus, the account menu, the option menus, the lists switcher). Each row lights its
// own hover (.menu__item, controls.scss). The rows are the slot, so each menu keeps its own markup and its own scoped styles
// (slot content belongs to the parent's scope).
//
// AND WHERE THE CARD HANGS. It places itself on the tick it mounts, which is every
// open (it mounts with the open menu), through useMenuPlacement: below its trigger
// unless only above has room, and from whichever edge keeps it on screen. Placement
// used to be a call each menu made for itself, and the four that never made it (the
// account menu, the ⋯ menus, the switcher) were placed by the stylesheet alone. That
// was right for a toolbar at the top of the page, where all four sit, and would have
// been wrong the day one of them moved. The props are useMenuPlacement's options.
//
// AND HOW WIDE IT IS. A card of words is pulled in to its longest line when it opens and
// whenever its contents change (hugText, app/utils), so text that wraps doesn't leave the
// card padded on one side; a card of rows is left alone, its rows already reaching the edge.
// It sizes before it places: placement reads the card's width.
//
// Classes, the aria-label, a role and anything else land on the list itself (attribute
// fallthrough), so `editor__actions` and the rest still read on the element they
// always did.
const {
  tag = "ul",
  fit = "flip",
  within = false,
  side = "end",
} = defineProps<{
  /** "div" for a card whose rows aren't one list: the switcher holds a search field,
   *  a scroller of lists and a footer. */
  tag?: "ul" | "div";
  /** how it keeps on screen sideways: "flip" to the other edge, or "center" under a
   *  small icon in the middle of something (a row's marks) */
  fit?: "flip" | "center";
  /** fit the card that clips it rather than the window, capped and scrolling when
   *  neither side has room (an option list inside the My Gear sheet) */
  within?: boolean;
  /** the edge it hangs from when both fit: "start" for a menu whose trigger opens the
   *  bar (the switcher) */
  side?: "end" | "start";
}>();

const listRef = useTemplateRef<HTMLElement>("listRef");
const { atStart, centered, above, shift, maxHeight, place } = useMenuPlacement(listRef, { fit, within, side });
onMounted(() => {
  hugText(listRef.value!);
  place();
});
onUpdated(() => {
  if (listRef.value) hugText(listRef.value);
});

const placed = computed(() => ({
  "menu__list--start": atStart.value,
  "menu__list--center": centered.value,
  "menu__list--above": above.value,
  "menu__list--capped": maxHeight.value != null,
}));
const placedStyle = computed(() => ({
  ...(shift.value ? { "--menu-shift": `${shift.value}px` } : {}),
  ...(maxHeight.value != null ? { maxHeight: `${maxHeight.value}px` } : {}),
}));
</script>

<template>
  <component
    :is="tag"
    ref="listRef"
    class="popover menu__list"
    :class="placed"
    :style="placedStyle"
    role="menu"
  >
    <slot />
  </component>
</template>
