<!-- Number-counter pop-in, adapted from the portfolio's <AnimatedCount>: when the
     value changes, each character (digits, separators, unit) re-mounts and pops in
     with a staggered translate+blur+fade. Takes the already-formatted string so it
     works for "4,723 g", "1.36 kg", "10.4 lb" alike. -->
<template>
  <span ref="el" class="acount" :class="{ 'is-animating': animating }">
    <!-- screen readers get the value as one string; the per-char spans (a known
         AT-fragmentation trap) are hidden from them -->
    <span class="acount__sr">{{ value }}</span>
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
/* visually hidden, still read by AT */
.acount__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@keyframes acount-pop {
  0% {
    transform: translateY(0.2em);
    opacity: 0;
    filter: blur(2px);
  }
  100% {
    transform: translateY(0);
    opacity: 1;
    filter: blur(0);
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
