<!-- Number-counter pop-in, adapted from the portfolio's <AnimatedCount>: when the
     value changes, each character (digits, separators, unit) re-mounts and pops in
     with a staggered translate + fade. Takes the already-formatted string so it
     works for "4,723 g", "1.36 kg", "10.4 lb" alike. -->
<template>
  <span ref="el" class="acount" :class="{ 'is-animating': animating }">
    <!-- screen readers get the value as one string; the per-char spans (a known
         AT-fragmentation trap) are hidden from them -->
    <span class="visually-hidden">{{ value }}</span>
    <span
      v-for="(char, i) in chars"
      :key="`${generation}-${i}`"
      class="acount__ch"
      aria-hidden="true"
      :style="{ '--i': i }"
    >{{ char }}</span>
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{ value: string }>();

const el = useTemplateRef<HTMLElement>("el");
const animating = ref(false);
const generation = ref(0);
const chars = ref<string[]>([...props.value]);

watch(
  () => props.value,
  (next) => {
    if (next === chars.value.join("")) return;
    animating.value = false;
    chars.value = [...next];
    generation.value++;
    nextTick(() => {
      void el.value?.offsetHeight; // force reflow so the keyframe restarts
      animating.value = true;
    });
  },
);

onMounted(() => {
  animating.value = true;
});
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
  animation: num-pop var(--dur-slow) var(--ease-spring) both;
  animation-delay: calc(var(--i, 0) * var(--stagger-ch)); /* 0 for the first char */
}
@media (prefers-reduced-motion: reduce) {
  .acount.is-animating .acount__ch {
    animation: none;
  }
}
</style>
