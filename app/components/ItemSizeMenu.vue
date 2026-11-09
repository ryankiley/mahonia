<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";
import type { Item, Unit } from "~~/shared/types";
import { formatWeight } from "~~/shared/weights";
import { sizePickPatch } from "~~/shared/catalogSizes";

// THE OTHER SIZES of the product a linked row is: a chevron after the row's Size field,
// listing each size with its cited weight in the row's unit; a pick relinks the row and
// takes that weight (shared/catalogSizes). ItemRow mounts this only while a linked row
// is being edited, and LAZILY: it is a click away on one row at a time, so it stays off
// the editor's first load (scripts/bundle-budget.mjs). Mounting is what asks for the
// sizes, so a list mounts no requests, and a product sold in one size draws nothing.
const props = defineProps<{ item: Item; unit: Unit; name: string }>();
defineEmits<{ overlayToggle: [boolean] }>();

const gear = useGearList();
const sizes = useCatalogSizes(
  computed(() => props.item.catalogItemId),
  computed(() => true),
);
const options = computed(() =>
  sizes.value.map((s) => ({
    key: String(s.id),
    label: s.variant || "No size given",
    detail: formatWeight(s.weightMg, props.unit),
  })),
);
function pick(key: string) {
  const size = sizes.value.find((s) => String(s.id) === key);
  if (size && size.id !== props.item.catalogItemId) gear.updateItem(props.item.id, sizePickPatch(size));
}
</script>

<template>
  <!-- mousedown.prevent keeps focus in the Size field: Safari doesn't focus a clicked
       button, so the field's blur would end the edit (ItemRow.onRowBlur) and unmount
       this under the click -->
  <OptionMenu
    v-if="options.length"
    class="sizemenu"
    :options="options"
    :current="String(item.catalogItemId)"
    label="Other sizes"
    fit="shift"
    :title="`Other sizes of ${name}`"
    @pick="pick"
    @overlay-toggle="$emit('overlayToggle', $event)"
    @mousedown.prevent
  >
    <template #trigger="{ open }">
      <span class="sizemenu__hit">
        <HugeiconsIcon
          :icon="ChevronDownIcon"
          class="chev sizemenu__chev"
          :class="{ 'is-open': open }"
          :size="12"
          :stroke-width="2"
          aria-hidden="true"
        />
      </span>
    </template>
  </OptionMenu>
</template>

<style scoped>
/* a hair off the field: flush, the trigger's focus ring sat on the italic size's last letter */
.sizemenu {
  margin-left: var(--space-1);
}
/* the chevron is 12px, and that is no target: the padding is the hit area, pulled back
   out of the line with the same margin so the field's line doesn't grow */
.sizemenu__hit {
  display: inline-flex;
  padding: var(--space-1) var(--space-2);
  margin-block: calc(-1 * var(--space-1));
}
@media (pointer: coarse) {
  .sizemenu__hit {
    padding: var(--space-2) var(--space-3);
    margin-block: calc(-1 * var(--space-2));
  }
}
/* the row's unit chevron's lift (ItemRow .item__unitchev): on the row's hover, and on
   keyboard focus of its own trigger */
@media (hover: hover) and (pointer: fine) {
  .item:hover .sizemenu__chev {
    color: var(--ink-2);
  }
}
.sizemenu:focus-within .sizemenu__chev {
  color: var(--ink-2);
}
</style>
