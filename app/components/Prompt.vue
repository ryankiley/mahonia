<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Cancel01Icon } from "@hugeicons/core-free-icons";

// A prompt carrying ONE decision, in the column after the figure it concerns.
//
// Not a toast. A toast reports something that already happened and leaves on a timer;
// this asks something and waits, because the answer is the point and a question that
// vanishes has to be asked again. It sits out of the transient stack deliberately:
// sharing that v-else-if chain with the undo bar meant removing an item hid the
// question for ten seconds. A quiet line, an optional action, and a dismiss that IS an
// answer; today, the vault asking whether gear from someone else's list is yours.
//
// Inline only. It also had a corner variant floating over the page, for a first-run
// pointer back to your saved lists; that pointer went, and the variant (and its lede)
// went with it.
const { show, dismissLabel = "Dismiss" } = defineProps<{
  show: boolean;
  /** what the × means here, since dismissing answers the question */
  dismissLabel?: string;
}>();

const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <!-- `appear`: the editor mounts this Lazy on its first show, so that mount IS the
       arrival, and unfolds the way a later one does. It sits IN the column, so
       dismissing it moves everything below: it leaves through the .reveal height
       recipe (a grid whose one row runs 1fr↔0fr, the inner clipping), and the content
       below eases up instead of jumping. -->
  <Transition name="reveal" appear>
    <div v-if="show" class="reveal" role="status">
      <div class="prompt">
        <span v-if="$slots.icon" class="prompt__icon" aria-hidden="true"><slot name="icon" /></span>
        <span class="prompt__text"><slot /></span>
        <slot name="action" />
        <button type="button" class="prompt__close" :aria-label="dismissLabel" :title="dismissLabel" @click="emit('dismiss')">
          <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" />
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Inline: an aside in the column, so it borrows the page's ink rather than the
   toast's inverted surface, and a hairline + faint fill is the whole of its chrome.
   Quiet on purpose — it's a question you can ignore, not a warning. */
.prompt {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  /* hugs its sentence rather than ruling off the column. A full-width bar reads as
     a system banner — something that happened TO the page; this is a question you
     can ignore, and it should take only the room the question needs. max-width
     keeps it inside the column when the text wraps on a narrow screen. */
  width: max-content;
  max-width: 100%;
  padding: var(--space-3) var(--space-4);
  background: var(--paper-2);
  /* --radius-4, not the in-flow --radius-2 this started with: the block hugs its
     sentence (width: max-content), so at one line it's a ~48px lozenge, and 8px on
     that reads as a rectangle someone forgot to round. Deliberately NOT --radius-pill
     either — the max-width above lets the sentence wrap on a narrow screen, and a
     pill on a two-line box becomes a stadium with the text pinched in its middle.
     At one line 20px is within 2px of a true pill anyway; at two it stays a card. */
  border-radius: var(--radius-4);
  color: var(--ink-2);
  font-size: var(--text-base);
}
.prompt__text {
  display: flex;
  flex-direction: column;
  gap: var(--space-px);
}
/* leading mark: same box and ink as the dismiss at the other end, so the two read
   as a matched pair bracketing the message */
.prompt__icon {
  flex: none;
  display: inline-flex;
  align-items: center;
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
.prompt__close:focus-visible {
  opacity: 1;
}
@media (hover: hover) and (pointer: fine) {
  .prompt__close:hover {
    opacity: 1;
  }
}
/* touch: the dismiss meets the --tap minimum (the house rule, controls.scss)
   without growing the prompt — the extra hit area overhangs the box via negative
   margins, the same trick the folder header uses */
@media (pointer: coarse) {
  .prompt__close {
    min-width: var(--tap);
    min-height: var(--tap);
    margin-block: calc((var(--tap) - 24px) / -2);
    margin-inline-end: calc((var(--tap) - 24px) / -2);
  }
}
</style>
