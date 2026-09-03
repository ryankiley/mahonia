<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";

// The collapse chevron a GROUP row trails its name with — the folder header's
// gesture at row scale, drawn once for the editor's two faces and the share views'
// row (ReadonlyItemRow). Its looks are the shared .item__nestcollapse /
// .item__nestchev recipe (atoms/folder.scss, one rule with the folder header's
// chevron); what this fixes is the ATTRIBUTES the
// three sites had each written out by hand: aria-expanded, the "Expand/Collapse
// <name>" accessible name, the title, and the rotate class on the glyph.
//
// `stop` is for the checklist face, where the button sits INSIDE the row's <label>
// over the packing checkbox: a click there must neither bubble to the label (which
// would toggle the tick) nor take the label's default.
//
// The editor's faces also pass `@mousedown.prevent` — a fallthrough listener onto
// the button — so a press here can't blur a focused field and discard a pristine
// blank row (see the actions cluster's comment in ItemRow). The read row has no
// field to protect and doesn't.
const props = defineProps<{
  collapsed: boolean;
  /** the group's name, for the accessible name — "Collapse Tent" */
  label: string;
  stop?: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();
function onClick(e: MouseEvent) {
  if (props.stop) {
    e.stopPropagation();
    e.preventDefault();
  }
  emit("toggle");
}
</script>

<template>
  <button
    class="item__nestcollapse"
    :aria-expanded="!collapsed"
    :aria-label="`${collapsed ? 'Expand' : 'Collapse'} ${label}`"
    :title="collapsed ? 'Expand group' : 'Collapse group'"
    @click="onClick"
  ><HugeiconsIcon :icon="ChevronDownIcon" class="item__nestchev" :class="{ 'is-collapsed': collapsed }" :size="16" :stroke-width="2" /></button>
</template>
