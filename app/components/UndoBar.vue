<script setup lang="ts">
import type { UndoOffer } from "~/composables/useUndo";

// "Removed <thing> · Undo", for the list editor and My Gear alike: one component, so the
// two say it the same way in the same place (the .toast and .undobar atoms,
// controls.scss). The timer is the caller's (useUndo); the bar only says when it is
// held — pointed at, or holding focus. Two flags, so letting go of one while the other
// still holds doesn't restart the clock. They go with the bar: it unmounts when the undo
// does, so a stale "hovered" can never pin the next one open.
//
// No icon on the button: the word is the control, and the bar is one line of text.
defineProps<{ undo: Pick<UndoOffer, "verb" | "label" | "tail"> }>();
const emit = defineEmits<{ take: []; hold: [held: boolean] }>();

const hovered = ref(false);
const focused = ref(false);
watch(
  () => hovered.value || focused.value,
  (held) => emit("hold", held),
);
</script>

<template>
  <div
    class="toast undobar"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focusin="focused = true"
    @focusout="focused = false"
  >
    <span class="t-sm">{{ undo.verb ?? "Removed" }} <strong>{{ undo.label }}</strong>{{ undo.tail ?? "" }}</span>
    <button type="button" class="undobar__btn t-sm" @click="emit('take')">Undo</button>
  </div>
</template>
