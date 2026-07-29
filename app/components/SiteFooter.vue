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
        <!-- "Gear vault" is the thing's name, so it needs no possessive and doesn't
             repeat the "Your" beside it — which is what made an earlier
             "Your lists / Your vault" pair read as a set apart from About and Legal.
             /mine keeps its original label.
             The vault link is unconditional, not gated on holding one: the footer is
             server-rendered on the read views and hasVault is a localStorage read, so
             a conditional link would either mismatch on hydration or flicker. /vault
             explains itself to someone who has none, exactly as /mine does with no
             lists. -->
        <NuxtLink to="/mine" class="foot__link t-sm">Your lists</NuxtLink>
        <NuxtLink to="/vault" class="foot__link t-sm">Gear vault</NuxtLink>
        <NuxtLink to="/about" class="foot__link t-sm">About</NuxtLink>
        <NuxtLink to="/legal" class="foot__link t-sm">Legal</NuxtLink>
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
  /* grow to fill the row so the copyright is pushed to the end; the copyright wraps to
     its own (left-aligned) line ONLY when nav + copy genuinely don't fit — not at a
     fixed breakpoint, which fired well before it was needed on phones */
  flex: 1 1 auto;
  gap: var(--space-3) var(--space-5);
}
.foot__link {
  color: var(--ink-2);
  border-bottom: 1px solid transparent;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.foot__link:hover {
  color: var(--ink);
  /* underline appears on hover but stays soft — never full-strength ink */
  border-bottom-color: var(--ink-2);
}
.foot__copy {
  /* no margin-left:auto + no forced wrap — .foot__nav's flex-grow pins this to the
     row's end, and natural flex-wrap drops it to its own left-aligned line when needed */
  flex: 0 1 auto;
}
</style>
