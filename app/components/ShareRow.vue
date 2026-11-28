<script setup lang="ts">
import { SvgIcon, type IconNode } from "~/utils/icon";

// One row of a sharing panel: glyph · label over a hint. The list's Sharing panel and
// My Gear's both draw their rows with it, so a link you can copy reads the same on
// either page: the label is the whole act ("Copy read-only link") and its accessible
// name, the hint says who that hands the thing to, and is the row's description.
//
// A menu row (.menu__item, the glyph in the menu's one glyph column) that wraps, since the hint is prose in a panel of fixed width, and
// hangs its glyph on the LABEL's line rather than the middle of the pair, so the mark
// stays with the word it marks.
defineProps<{ icon: IconNode; label: string; hint: string }>();
defineEmits<{ click: [] }>();
const hintId = useId();
</script>

<template>
  <button
    type="button"
    class="menu__item share-row"
    :aria-label="label"
    :aria-describedby="hintId"
    @click="$emit('click')"
  >
    <SvgIcon :icon="icon" aria-hidden="true" />
    <span class="share-row__text">
      <span class="share-row__name"><slot>{{ label }}</slot></span>
      <span :id="hintId" class="share-row__hint">{{ hint }}</span>
    </span>
  </button>
</template>

<style scoped>
.share-row {
  align-items: start;
  white-space: normal;
}
.share-row > svg {
  margin-block: calc((1lh - var(--icon)) / 2);
}
.share-row__text {
  display: grid;
  flex: 1 1 auto;
}
.share-row__name {
  color: var(--foreground-primary);
}
.share-row__hint {
  color: var(--foreground-secondary);
  font-size: var(--text-chrome);
}
</style>
