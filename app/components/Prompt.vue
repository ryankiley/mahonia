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
const { show, lede, dismissLabel = "Dismiss", variant = "corner" } = defineProps<{
  show: boolean;
  /** the quieter half — what this is about; the slot carries what's being asked */
  lede?: string;
  /** what the × means here, since dismissing answers the question */
  dismissLabel?: string;
  /**
   * Where it sits, which is a question about what it interrupts.
   *
   * "corner" floats over the page: right for something that isn't about what
   * you're looking at (the pointer back to your OTHER lists), and which must not
   * push the thing you came to do down the screen.
   *
   * "inline" sits in the content, after the figure it concerns: right for a
   * question ABOUT this list, where floating over the page overstates it. It
   * takes the page's own ink rather than the inverted toast surface — it's an
   * aside in the column, not an alert on top of it.
   */
  variant?: "corner" | "inline";
}>();

const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <Transition :name="variant === 'corner' ? 'toast' : 'promptin'">
    <!-- Corner: fixed, so nothing reflows when it goes — a fade and a small rise
         is the whole exit. -->
    <div v-if="show && variant === 'corner'" class="toast toast--corner prompt" role="status">
      <!-- leading, so the mark registers before the sentence does — the same
           placement (and the same reasoning) as the vault mark in the autocomplete -->
      <span v-if="$slots.icon" class="prompt__icon" aria-hidden="true"><slot name="icon" /></span>
      <span class="prompt__text">
        <span v-if="lede" class="prompt__lede">{{ lede }}</span>
        <slot />
      </span>
      <slot name="action" />
      <button type="button" class="prompt__close" :aria-label="dismissLabel" :title="dismissLabel" @click="emit('dismiss')">
        <X :size="15" :stroke-width="2" />
      </button>
    </div>

    <!-- Inline: it sits IN the column, so dismissing it moves everything below.
         It leaves through a height animation — the house recipe, a grid whose
         single row runs 1fr↔0fr with the inner clipping (the packing bar and a
         row's note use the same one; height:auto↔0 would just snap in Safari,
         which has no interpolate-size). The content below eases up instead of
         jumping. -->
    <div v-else-if="show" class="prompt-reveal" role="status">
      <div class="prompt-reveal__inner">
        <div class="prompt prompt--inline">
          <span v-if="$slots.icon" class="prompt__icon" aria-hidden="true"><slot name="icon" /></span>
          <span class="prompt__text">
            <span v-if="lede" class="prompt__lede">{{ lede }}</span>
            <slot />
          </span>
          <slot name="action" />
          <button type="button" class="prompt__close" :aria-label="dismissLabel" :title="dismissLabel" @click="emit('dismiss')">
            <X :size="15" :stroke-width="2" />
          </button>
        </div>
      </div>
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
/* The toast transition translates -50% on X — it centres a fixed element on the
   viewport, and on an inline banner it would slide the thing half its own width
   sideways as it arrives. So the inline variant gets its own: a plain fade and a
   small rise, no horizontal component to undo. */
.promptin-enter-active {
  transition:
    opacity var(--dur) var(--ease),
    grid-template-rows var(--dur) var(--ease);
}
/* the exit is what matters here — it's the one that moves the page */
.promptin-leave-active {
  transition:
    opacity calc(var(--dur) * 0.6) var(--ease),
    grid-template-rows var(--dur) var(--ease);
}
.promptin-enter-from,
.promptin-leave-to {
  opacity: 0;
  grid-template-rows: 0fr;
}
/* the wrapper IS the animation: one row, 1fr → 0fr, inner clipping */
.prompt-reveal {
  display: grid;
  grid-template-rows: 1fr;
}
.prompt-reveal__inner {
  min-height: 0;
  overflow: hidden;
}

/* Inline: an aside in the column, so it borrows the page's ink rather than the
   toast's inverted surface, and a hairline + faint fill is the whole of its chrome.
   Quiet on purpose — it's a question you can ignore, not a warning. */
.prompt--inline {
  display: flex;
  align-items: center;
  /* hugs its sentence rather than ruling off the column. A full-width bar reads as
     a system banner — something that happened TO the page; this is a question you
     can ignore, and it should take only the room the question needs. max-width
     keeps it inside the column when the text wraps on a narrow screen. */
  width: max-content;
  max-width: 100%;
  padding: var(--space-3) var(--space-4);
  background: var(--paper-2);
  border-radius: var(--radius-2);
  color: var(--ink-2);
  font-size: var(--text-sm);
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
.prompt__close:hover,
.prompt__close:focus-visible {
  opacity: 1;
}
</style>
