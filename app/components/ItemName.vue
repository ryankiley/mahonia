<script setup lang="ts">
import type { Item } from "~~/shared/types";
import { itemSearchName, itemSearchUrl } from "~~/shared/links";
import { itemDisplayName } from "~~/shared/weights";

// Renders a product like "Sea to Summit Trek TkII Down Sleeping Bag · Long, 18F":
// brand + model in normal ink; the variant as a dimmed " · …" suffix. A
// custom-renamed item (nameOverridden) drops brand/variant and shows just the name.
//
// With `search` (the read-only share views), ONLY the product name (brand + model)
// becomes a web-search link — the variant stays plain text OUTSIDE the anchor, so
// the link's dotted underline never runs under the variant. Water / unnamed rows
// resolve to no link (itemSearchUrl → null), so they render as plain text.
const props = defineProps<{ item: Item; search?: boolean }>();
const main = computed(() => itemDisplayName(props.item.brand, props.item.name));
const variant = computed(() => (props.item.nameOverridden ? "" : props.item.variant || ""));
const href = computed(() => (props.search ? itemSearchUrl(props.item) : null));
const searchLabel = computed(() => `Search the web for ${itemSearchName(props.item)}`);
</script>

<template>
  <span class="iname"><a
      v-if="href"
      class="iname__link"
      :href="href"
      target="_blank"
      rel="noopener noreferrer"
      :aria-label="searchLabel"
    >{{ main }}</a><template v-else>{{ main }}</template><span v-if="variant" class="iname__variant"> · {{ variant }}</span></span>
</template>

<style scoped>
.iname__variant {
  color: var(--ink-3);
  font-style: italic;
}
/* read-only search link: a persistent DOTTED underline marks the product NAME as a
   lookup link. Only the name lives inside this anchor (the variant is a sibling
   outside it), so the underline never runs under the variant. Soft colour, firming
   to --ink-2 on hover/focus, never full ink. */
.iname__link {
  color: inherit;
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-decoration-color: var(--underline);
  text-decoration-thickness: 1px; /* from-font is heavy; pin it thin */
  text-underline-offset: 2px;
  transition: text-decoration-color var(--dur) var(--ease);
}
.iname__link:hover,
.iname__link:focus-visible {
  text-decoration-color: var(--ink-2);
}
</style>
