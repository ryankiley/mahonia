<script setup lang="ts">
// The one site-wide footer — a slim legal line, mounted by the default layout and
// the editor so every page gets the exact same footer. Just the legal links + the
// copyright; contact lives on the About page, not here. Monochrome chrome.
const year = new Date().getFullYear();
</script>

<template>
  <footer class="foot">
    <div class="wrap foot__inner">
      <nav class="foot__nav" aria-label="Footer">
        <NuxtLink to="/about" class="foot__link t-sm">About</NuxtLink>
        <NuxtLink to="/privacy" class="foot__link t-sm">Privacy</NuxtLink>
        <NuxtLink to="/terms" class="foot__link t-sm">Terms</NuxtLink>
      </nav>

      <p class="t-sm t-muted foot__copy">© {{ year }} Mahonia</p>
    </div>
  </footer>
</template>

<style scoped>
.foot {
  border-top: 1px solid var(--line);
  /* the single content→footer gap, site-wide — matches the inter-folder rhythm
     (--space-7). Page containers add no bottom padding, so this isn't doubled. */
  margin-top: var(--space-7);
}
.foot__inner {
  padding-block: var(--space-5);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3) var(--space-5);
}
.foot__nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-5);
}
.foot__link {
  color: var(--ink-2);
  border-bottom: 1px solid transparent;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.foot__link:hover {
  color: var(--ink);
  border-bottom-color: var(--ink);
}
.foot__copy {
  margin-left: auto;
}
@media (max-width: 560px) {
  .foot__copy {
    margin-left: 0;
    flex-basis: 100%;
  }
}
</style>
