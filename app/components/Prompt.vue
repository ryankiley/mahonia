<script setup lang="ts">
import { X } from "@lucide/vue";

// A persistent corner prompt carrying ONE decision.
//
// Not a toast, though it wears the toast surface. A toast reports something that
// already happened and leaves on a timer; this asks something and waits, because
// the answer is the point and a question that vanishes has to be asked again. It
// also sits out of the transient stack deliberately — sharing that v-else-if chain
// with the undo bar meant removing an item hid the question for ten seconds.
//
// Two users today, and they're the same object: the first-run pointer back to your
// saved lists, and the vault asking whether gear from someone else's list is yours.
// Both are a quiet line, an optional action, and a dismiss that IS an answer.
//
// Bottom-RIGHT (the .toast--corner atom): the centre is where passing messages
// land, and something that stays parked there would be in their way.
const { show, lede, dismissLabel = "Dismiss" } = defineProps<{
  show: boolean;
  /** the quieter half — what this is about; the slot carries what's being asked */
  lede?: string;
  /** what the × means here, since dismissing answers the question */
  dismissLabel?: string;
}>();

const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <Transition name="toast">
    <div v-if="show" class="toast toast--corner prompt" role="status">
      <span class="prompt__text">
        <span v-if="lede" class="prompt__lede">{{ lede }}</span>
        <slot />
      </span>
      <!-- the caller's affirmative, when there is one; a prompt with no action is
           just a pointer you dismiss -->
      <slot name="action" />
      <button type="button" class="prompt__close" :aria-label="dismissLabel" :title="dismissLabel" @click="emit('dismiss')">
        <X :size="14" />
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* .toast already sets `color: var(--paper)` for the whole surface, and the reset
   gives buttons and links `color: inherit` + no chrome — so what's here is only
   geometry and the two quiet steps down in emphasis. */
.prompt {
  gap: var(--space-4);
}
.prompt__text {
  display: flex;
  flex-direction: column;
  gap: var(--space-px);
}
/* The lede explains, the slot asks. Stepped back with opacity rather than a dimmer
   token — the ink/paper pair inverts with the colour scheme, and the --ink-N ramp
   doesn't exist in reverse for text ON ink. */
.prompt__lede {
  opacity: 0.72;
}
.prompt__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  padding: var(--space-1);
  opacity: 0.72;
}
.prompt__close:hover,
.prompt__close:focus-visible {
  opacity: 1;
}
</style>
