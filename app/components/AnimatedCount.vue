<!-- Number-counter pop-in, adapted from the portfolio's <AnimatedCount>: when the
     value changes, each character (digits, separators, unit) re-mounts and pops in
     with a staggered translate + fade. Takes the already-formatted string so it
     works for "4,723 g", "1.36 kg", "10.4 lb" alike. -->
<template>
  <span
    ref="el"
    class="acount"
    :class="{ 'is-animating': animating }"
    :style="{ '--acount-len': Math.max(1, chars.length) }"
  >
    <!-- screen readers get the value as one string; the per-char spans (a known
         AT-fragmentation trap) are hidden from them -->
    <span class="visually-hidden">{{ value }}</span>
    <span
      v-for="(char, i) in chars"
      :key="`${generation}-${i}`"
      class="acount__ch"
      :class="{ 'is-late': i >= born }"
      aria-hidden="true"
      :style="{ '--i': i }"
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

const el = useTemplateRef<HTMLElement>("el");
const animating = ref(false);
const generation = ref(0);
const chars = ref<string[]>([...props.value]);

// ONE RUN AT A TIME. A run is the cascade: every character re-mounted (a new generation
// of keys) and popped in, each a --stagger-ch after the one before. Only a change that
// arrives with nothing playing starts one. A change from the KEYBOARD (holding ↑ in a
// weight field steps the total at the key-repeat rate) or one that lands while a run is
// still playing (the ± stepper pressed in a quick run) is written into the nodes already
// there instead: same keys, same nodes, so no character starts over. Starting over is
// what blanked the total — every restart threw each character back to the keyframe's
// transparent first frame and held the later ones there through their stagger delay,
// so a fast enough run of changes left most of the figure invisible.
//
// `born`: how many positions the run's own render created. A position past it got its
// node from one of those in-place writes (the figure grew a digit mid-run, or from the
// keyboard), and sits the run out (.is-late) rather than joining it a stagger late,
// transparent until it does.
const born = ref(chars.value.length);
let runUntil = 0; // performance.now() at which the run playing now has landed

function runMs(): number {
  const stagger = (el.value && parseFloat(getComputedStyle(el.value).getPropertyValue("--stagger-ch"))) || 40;
  return springCss("pop").duration + stagger * Math.max(0, chars.value.length - 1);
}
function play() {
  born.value = chars.value.length;
  runUntil = performance.now() + runMs();
  animating.value = true;
}

watch(
  () => props.value,
  (next) => {
    if (next === chars.value.join("")) return;
    if (motionIsInstant() || performance.now() < runUntil) {
      chars.value = [...next];
      born.value = Math.min(born.value, chars.value.length);
      return;
    }
    animating.value = false;
    chars.value = [...next];
    generation.value++;
    nextTick(() => {
      void el.value?.offsetHeight; // force reflow so the keyframe restarts
      play();
    });
  },
);

onMounted(play);
</script>

<style scoped>
.acount {
  display: inline-flex;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  --stagger-ch: 40ms; /* per-digit cascade step (its own slower cadence vs the folder --stagger) */
}
.acount__ch {
  display: inline-block;
  white-space: pre; /* keep the space before the unit */
  /* §6 "Rung 2": rest at blur(0) (never `none`, so the filter context persists) AND
     force a standing GPU layer with translateZ(0). iOS Safari often won't RENDER a
     filter animation at all unless the element is composited; Rung 1 (blur-at-rest
     alone) left the blur invisible on real iOS hardware. The layer is baked into the
     keyframe transforms too (a static transform here is overwritten while `transform`
     animates), so it persists through and after the run. */
  filter: blur(0);
  transform: translateZ(0);
}
/* .acount__sr → migrated to the shared global .visually-hidden utility
   (app/assets/styles/foundations/reset.scss) */
/* the keyframe itself → the shared global `num-pop` (app/assets/styles/main.scss).
   The row's quantity stepper pops its number with the same motion, and a scoped
   @keyframes is renamed per component — kept here, the two would have been two
   copies of one idea. The per-character stagger below stays local: it is what
   makes this the TOTAL's version of the pop. */
.acount.is-animating .acount__ch {
  animation: num-pop var(--spring-pop-dur) var(--spring-pop) both;
  animation-delay: calc(var(--i, 0) * var(--stagger-ch)); /* 0 for the first char */
}
/* a node born after its run began (`born`, above): already in place, never transparent */
.acount.is-animating .acount__ch.is-late {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .acount.is-animating .acount__ch {
    animation: none;
  }
}
</style>
