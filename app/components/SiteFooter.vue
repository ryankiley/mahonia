<script setup lang="ts">
// The one site-wide footer — a slim legal line, mounted by the default layout and
// the editor so every page gets the exact same footer. Just the legal links + the
// copyright; contact lives on the About page, not here. Monochrome chrome.
const year = new Date().getFullYear();

// No feedback trigger here any more — it lives in the editor's actions menu. The
// footer is a legal line: four places to go and a copyright. A dialog launcher styled
// to pass as a link in that row was the odd one out, and "send feedback" belongs
// beside the thing you'd be reporting on rather than under it.

// Set by the editor, which carries "Your lists" in its side nav. DESKTOP ONLY, in
// the styles below — the nav isn't rendered under $bp-full, where this row is then
// the only route to /mine, and /mine owns deleting a list. A phone would otherwise
// be left with no way to reach it but typing the URL.
const { listsInNav = false } = defineProps<{ listsInNav?: boolean }>();
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
        <NuxtLink
          to="/mine"
          class="foot__link t-sm"
          :class="{ 'foot__link--in-nav': listsInNav }"
        >Your lists</NuxtLink>
        <NuxtLink to="/vault" class="foot__link t-sm">Gear vault</NuxtLink>
        <NuxtLink to="/about" class="foot__link t-sm">About</NuxtLink>
        <NuxtLink to="/legal" class="foot__link t-sm">Legal</NuxtLink>
      </nav>

      <p class="t-sm t-muted foot__copy">© {{ year }} Mahonia</p>
    </div>
  </footer>
</template>

<style scoped lang="scss">
.foot {
  /* the single content→footer gap, site-wide — matches the inter-folder rhythm
     (--space-7). Page containers add no bottom padding, so this isn't doubled. */
  margin-top: var(--space-7);
}
/* The rule is on the INNER column, not the outer block: it marks where the page's
   content ends, so it should measure the content — not run the width of whatever
   shell the page happens to sit in. In the editor that shell now reaches from the
   side nav to the window edge, and a hairline spanning all of it was drawing a line
   under two things (the list, and the empty margin beside it) to end one. */
.foot__inner {
  border-top: 1px solid var(--line);
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
/* Where the editor's side nav is on screen, the footer stops repeating its first
   link. Below the nav's breakpoint the link comes back, because there it's the only
   route to /mine — see the note in the script. */
@media (min-width: $bp-full + 1px) {
  .foot__link--in-nav {
    display: none;
  }
}
</style>
