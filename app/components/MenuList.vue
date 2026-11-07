<script setup lang="ts">
// THE MENU LIST: the card a menu's rows sit in, and the travelling wash that lights
// them. Every anchored menu in the app is this (the ⋯ menus, sharing, the account
// menu, the option menus, the lists switcher); each one spelled it out by hand, the
// `ul`, its first `li` holding the plate, and the useMenuPlate() call wired to both.
// The rows are the slot, so each menu keeps its own markup and its own scoped styles
// (slot content belongs to the parent's scope).
//
// Classes, the aria-label and anything else land on the list itself (attribute
// fallthrough), so `menu__list--start`, `editor__actions` and the rest still read on
// the element they always did.
const { tag = "ul" } = defineProps<{
  /** "div" for a card whose rows aren't one list: the switcher holds a search field,
   *  a scroller of lists and a footer, and the plate sits bare in the card so it can
   *  travel between them (see useMenuPlate's offsetIn). */
  tag?: "ul" | "div";
}>();

const { plateRef, listRef, on } = useMenuPlate();

// For a menu that measures its own card (OptionMenu's useMenuPlacement).
defineExpose({ el: listRef });
</script>

<template>
  <component :is="tag" ref="listRef" class="popover menu__list" role="menu" v-on="on">
    <!-- role="none" so the decorative plate can't read as a menu item -->
    <li v-if="tag === 'ul'" role="none" aria-hidden="true">
      <span ref="plateRef" class="menu__plate" />
    </li>
    <span v-else ref="plateRef" class="menu__plate" aria-hidden="true" />
    <slot />
  </component>
</template>
