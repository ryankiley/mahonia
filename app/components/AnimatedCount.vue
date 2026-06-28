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
      :style="i > 0 ? { animationDelay: `${i * 40}ms` } : undefined"
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
}
.acount__ch {
  display: inline-block;
  white-space: pre; /* keep the space before the unit */
}
/* .acount__sr → migrated to the shared global .visually-hidden utility
   (app/assets/styles/foundations/reset.scss) */
/* no filter:blur — Safari can leave the last character stuck in a blurred
   compositing layer (it fails to repaint the final blur(0) state). translate +
   opacity alone give the pop-in and never freeze. */
@keyframes acount-pop {
  0% {
    transform: translateY(0.2em);
    opacity: 0;
  }
  100% {
    transform: translateY(0);
    opacity: 1;
  }
}
.acount.is-animating .acount__ch {
  animation: acount-pop var(--dur-slow) var(--ease-spring) both;
}
@media (prefers-reduced-motion: reduce) {
  .acount.is-animating .acount__ch {
    animation: none;
  }
}
</style>
