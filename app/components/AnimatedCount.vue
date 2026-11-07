<!-- A figure that shows its own change, and only its change. When the value changes,
     the characters that CHANGED drop in; the rest are the same DOM nodes they were and
     never move. Takes the already-formatted string so it works for "4,723 g",
     "1.36 kg", "10.4 lb" alike. -->
<template>
  <span class="acount" :style="{ '--acount-len': Math.max(1, chars.length) }">
    <!-- screen readers get the value as one string; the per-char spans (a known
         AT-fragmentation trap) are hidden from them -->
    <span class="visually-hidden">{{ value }}</span>
    <!-- keyed by POSITION + CHARACTER: an unchanged character keeps its key, so Vue
         keeps its node and its finished animation is left alone; a changed one gets a
         new key, a new node, and the drop-in plays once on that node's arrival -->
    <span
      v-for="(char, i) in chars"
      :key="`${i}:${char}`"
      class="acount__ch"
      :class="{ 'is-new': fresh.has(i) }"
      aria-hidden="true"
    >{{ char }}</span>
  </span>
</template>

<script setup lang="ts">
import { motionIsInstant } from "~/plugins/inputModality.client";

// `--acount-len` (the character count, published on the root) is what lets a caller
// keep a long figure inside a narrow screen: the display size is a single unbreakable
// token that neither wraps nor ellipsizes, so past a certain length it simply ran off
// the edge of a phone — number, unit and all — with the page refusing to scroll
// sideways. Only the count can say when that is about to happen, and only this
// component knows it. See .t-display (foundations/typography.scss) for the size rule.
//
// Floored at 1 because the callers DIVIDE by it: a zero would make their calc()
// divide by zero, which is invalid at computed-value time and drops the whole
// font-size declaration back to the inherited body size. The `, 6` fallback in
// those rules only covers the property being absent, not being unusable.
const props = defineProps<{ value: string }>();
const chars = computed(() => [...props.value]);

// WHEN IT MOVES. A number on a page is something being read, so it animates only to
// show that it CHANGED, and only the part that did:
//   · never on mount — the first paint (and a value that settles just after it, like
//     a hydrating total) is the figure, not news about it;
//   · on a change, the positions whose character differs, each once, together — no
//     stagger, which made a five-digit total spell itself out over a quarter second;
//   · not at all when the change came off the keyboard (holding ↑ in a weight field
//     steps the total at the key-repeat rate, and a figure re-dropping on every step left
//     most of its digits invisible) or lands within QUIET_MS of the last one (a
//     stepper pressed in a run). Fast changes just show the number.
// It used to re-key EVERY character on every change (a generation counter) and replay
// the pop on all of them, with a forced reflow to restart it.
const QUIET_MS = 200;
const fresh = shallowRef<ReadonlySet<number>>(new Set());
let lastChange = typeof performance === "undefined" ? 0 : performance.now();
watch(
  () => props.value,
  (next, prev) => {
    const now = performance.now();
    const rapid = now - lastChange < QUIET_MS;
    lastChange = now;
    if (rapid || motionIsInstant()) {
      fresh.value = new Set();
      return;
    }
    const was = [...prev];
    const changed = new Set<number>();
    [...next].forEach((ch, i) => {
      if (was[i] !== ch) changed.add(i);
    });
    fresh.value = changed;
  },
);
</script>

<style scoped>
.acount {
  display: inline-flex;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.acount__ch {
  display: inline-block;
  white-space: pre; /* keep the space before the unit */
  /* §6 "Rung 2": rest at blur(0) (never `none`, so the filter context persists) AND
     force a standing GPU layer with translateZ(0). iOS Safari often won't RENDER a
     filter animation at all unless the element is composited; Rung 1 (blur-at-rest
     alone) left the blur invisible on real iOS hardware. The layer is baked into the
     keyframe transforms too (a static transform here is overwritten while `transform`
     animates), so it persists through and after the run. Kept as it was when the
     drop-in moved from every character to the changed ones: a changed character is a
     new node, so its run begins with the node, and these rest values are what it is
     born into. */
  filter: blur(0);
  transform: translateZ(0);
}
/* .acount__sr → migrated to the shared global .visually-hidden utility
   (app/assets/styles/foundations/reset.scss) */
/* the keyframe itself → the shared global `num-pop` (main.scss): a 0.2em drop, a fade
   and a 2px blur. `is-new` is set only on a character that changed on this render, so
   the run plays once, on that node's arrival; the script decides when not to set it
   (mount, the keyboard, a rapid run, reduced motion). */
.acount__ch.is-new {
  animation: num-pop var(--spring-pop-dur) var(--spring-pop) both;
}
</style>
