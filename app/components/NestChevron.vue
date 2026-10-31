<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";

// The collapse chevron — the one a GROUP row trails its name with, and with `folder`
// the same gesture at the folder header's scale: the editor's folder, the share views'
// folder, My Gear's folder and the trip panel's day all fold on it. Its looks are the
// shared .folder__collapse / .item__nestcollapse recipe (atoms/folder.scss, one rule for
// both scales); what this fixes is the ATTRIBUTES seven sites had each written out by
// hand: aria-expanded, the "Expand/Collapse <name>" accessible name, the title, and the
// rotate class on the glyph.
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
  /** the folder header's scale: a 20px glyph on the .folder__collapse box */
  folder?: boolean;
  /** what the title calls the thing folding — "group" and "folder" by default; the trip
   *  panel's days say "day" */
  noun?: string;
}>();
const emit = defineEmits<{ toggle: [] }>();
const noun = computed(() => props.noun ?? (props.folder ? "folder" : "group"));
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
    :class="folder ? 'folder__collapse' : 'item__nestcollapse'"
    :aria-expanded="!collapsed"
    :aria-label="`${collapsed ? 'Expand' : 'Collapse'} ${label}`"
    :title="`${collapsed ? 'Expand' : 'Collapse'} ${noun}`"
    @click="onClick"
  ><HugeiconsIcon :icon="ChevronDownIcon" :class="[folder ? 'folder__chev' : 'item__nestchev', { 'is-collapsed': collapsed }]" :size="folder ? 20 : 16" :stroke-width="2" /></button>
</template>
