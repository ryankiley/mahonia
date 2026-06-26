<script setup lang="ts">
// The one site-wide footer. Mounted by the default layout, so every page gets it.
// Monochrome chrome (no colour — the only colour on the site is the category viz).
// Contact is a single mailto — it doubles as the Terms takedown / abuse address.
// CONTACT_EMAIL is auto-imported from app/utils/site.
const year = new Date().getFullYear();
</script>

<template>
  <footer class="foot">
    <div class="wrap foot__inner">
      <div class="foot__brand">
        <NuxtLink to="/" class="t-label foot__name">Gear</NuxtLink>
        <p class="t-sm t-muted foot__tag">Pack lists, weighed. No login.</p>
      </div>

      <nav class="foot__nav" aria-label="Footer">
        <NuxtLink to="/privacy" class="foot__link t-sm">Privacy</NuxtLink>
        <NuxtLink to="/terms" class="foot__link t-sm">Terms</NuxtLink>
        <NuxtLink to="/changes" class="foot__link t-sm">Catalog changes</NuxtLink>
        <a :href="`mailto:${CONTACT_EMAIL}`" class="foot__link t-sm">Contact</a>
      </nav>

      <p class="t-sm t-muted foot__copy">© {{ year }} Gear</p>
    </div>
  </footer>
</template>

<style scoped>
.foot {
  border-top: 1px solid var(--line);
  margin-top: var(--space-9);
}
.foot__inner {
  padding-block: var(--space-6) var(--space-7);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-4) var(--space-6);
}
.foot__brand {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.foot__name {
  color: var(--ink);
}
.foot__tag {
  max-width: 28ch;
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
