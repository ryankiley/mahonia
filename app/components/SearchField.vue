<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { CircleXIcon } from "@hugeicons/core-free-icons";

// A search box with its own clear — the one /gear and the gear pane both draw.
//
// Our own clear, not the platform's: WebKit's cancel button is a filled BLUE circle-x,
// the only colour in the chrome (suppressed in atoms/controls.scss). This is the same
// glyph in the site's ink. Its own component because the pair — the field, the clear
// sitting ON it, the coarse-pointer tap target — existed twice, class for class, and
// two copies of one control is how the two surfaces start to drift.
//
// Sizing is the caller's: the root takes whatever class it's given (the pane stretches
// it, the page caps it at 32ch), and the field inside fills it.
defineProps<{ placeholder: string; label: string }>();
const query = defineModel<string>({ required: true });
const inputEl = useTemplateRef<HTMLInputElement>("inputEl");

// clearing returns you to the field, not to nowhere — you cleared it to type again
function clear() {
  query.value = "";
  inputEl.value?.focus();
}
/** The pane focuses the field on open; the keyboard should already be where you'd type. */
defineExpose({ focus: () => inputEl.value?.focus() });
</script>

<template>
  <div class="sf">
    <input
      ref="inputEl"
      v-model="query"
      class="field well sf__input"
      type="search"
      :placeholder="placeholder"
      :aria-label="label"
    />
    <button
      v-if="query"
      type="button"
      class="sf__clear"
      aria-label="Clear search"
      title="Clear search"
      @click="clear"
    >
      <HugeiconsIcon :icon="CircleXIcon" :size="16" :stroke-width="2" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.sf {
  position: relative;
  display: flex;
  align-items: center;
}
/* the tint is the shared .well atom (controls.scss) — CONTAINED, not a hairline
   rule: search is the one control you reach for on either surface, and an underline
   reads as a caption with a line under it rather than a box you can type in. */
.sf__input {
  width: 100%;
  padding-inline: var(--space-3);
  /* room for the clear button, so a long query doesn't run under it */
  padding-right: var(--space-5);
}
/* Sits ON the field rather than beside it: the rule under the input is the field's
   whole visible boundary, and a sibling button would either break that line or push
   the input narrower whenever a query exists (a field that resizes as you type). */
.sf__clear {
  position: absolute;
  right: 0;
  display: inline-flex;
  align-items: center;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.sf__clear:hover,
.sf__clear:focus-visible {
  color: var(--ink);
}
/* touch: the clear meets the --tap minimum (controls.scss); it overlays the
   field's end, so the bigger box only widens its hit area, not the layout */
@media (pointer: coarse) {
  .sf__clear {
    justify-content: center;
    min-width: var(--tap);
    min-height: var(--tap);
  }
}
</style>
