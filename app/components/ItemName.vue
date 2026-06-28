<script setup lang="ts">
import type { Item } from "~~/shared/types";

// Renders a product like "Sea to Summit Trek TkII Down Sleeping Bag · Long, 18F":
// brand + model in normal ink; the variant as a dimmed " · …" suffix. A
// custom-renamed item (nameOverridden) drops brand/variant and shows just the name.
const props = defineProps<{ item: Item }>();
const main = computed(() => [props.item.brand, props.item.name].filter(Boolean).join(" "));
const variant = computed(() => (props.item.nameOverridden ? "" : props.item.variant || ""));
</script>

<template>
  <span class="iname"
    >{{ main }}<span v-if="variant" class="iname__variant"> · {{ variant }}</span></span
  >
</template>

<style scoped>
.iname__variant {
  color: var(--ink-3);
  font-style: italic;
}
</style>
