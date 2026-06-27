<script setup lang="ts">
// The one site-wide top bar: the Mahonia wordmark linking home, plus a slot for
// the page's right-hand chrome (a section label, and on the read views a "Make
// your own" button that floats to the end). Mirrors SiteFooter — every routed
// page rendered its own byte-identical copy of this header before. The editor
// (/e) keeps its own sticky variant and does not use this.
defineProps<{
  // read views pack the brand + label tighter (gap-2 vs the default gap-3)
  compact?: boolean;
}>();
</script>

<template>
  <header class="topbar">
    <div class="wrap topbar__inner" :class="{ 'topbar__inner--compact': compact }">
      <NuxtLink to="/" class="t-label brand">Mahonia</NuxtLink>
      <slot />
    </div>
  </header>
</template>

<style scoped>
.topbar {
  border-bottom: 1px solid var(--line);
}
.topbar__inner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-block: var(--space-3);
}
.topbar__inner--compact {
  gap: var(--space-2);
}
.brand {
  color: var(--ink);
}
/* a slotted action (the "Make your own" button) floats to the trailing edge */
:slotted(.btn) {
  margin-left: auto;
}
</style>
