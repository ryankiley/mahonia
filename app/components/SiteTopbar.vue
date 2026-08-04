<script setup lang="ts">
// The one site-wide top bar: the Mahonia wordmark linking home, plus a slot for
// the page's right-hand chrome (a section label, and on the read views a "Make
// your own" button that floats to the end). Mirrors SiteFooter — every routed
// page rendered its own byte-identical copy of this header before. The editor
// (/e) keeps its own sticky variant and does not use this.
defineProps<{
  // read views pack the brand + label tighter (gap-2 vs the default gap-3)
  compact?: boolean;
  // A section name — the bar's other shape. /about, /legal and /changes each wrote
  // the same muted span; this is that one pattern, named once.
  label?: string;
}>();
</script>

<template>
  <header class="topbar">
    <div class="wrap topbar__inner" :class="{ 'topbar__inner--compact': compact }">
      <NuxtLink to="/" class="t-label brand">Mahonia</NuxtLink>
      <span v-if="label" class="t-sm t-muted">{{ label }}</span>
      <!-- One trailing group rather than each child racing for margin-left:auto.
           With the account control always present, a per-child auto margin on the
           slotted button pushed the two apart instead of keeping them together. -->
      <span class="topbar__trail">
        <slot />
        <!-- last, so a page's own action stays the prominent one.
             `compact` FORWARDS: it's the read views' flag, and their trailing group is
             a glyph row (the ⋯ menu) behind one text action. Left unforwarded, the bar
             was inconsistent with itself — signed in it drew the account glyph, signed
             out it drew the word "Sign in", so the same corner changed shape on a state
             that has nothing to do with shape. AccountMenu already carries the icon
             variant for exactly this; it was simply unreachable here. The plain word
             stays on /about, /legal, /mine and friends, which don't pass compact. -->
        <AccountMenu :compact="compact" />
        <!-- After the account control, for the one thing that outranks it at the end
             of a bar: an overflow ⋯. The editor already ends this way (vault, account,
             share, ⋯), so a bar that put ⋯ mid-row read as a different bar. It isn't a
             competing action — it's the end-cap, and it's where a hand goes looking. -->
        <slot name="end" />
      </span>
    </div>
  </header>
</template>

<style scoped>
/* sticks to the top on scroll, matching the editor's own sticky topbar — so the
   read views (and every other page using this bar) keep their nav + actions in
   reach through a long list. */
.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-topbar);
  background: var(--paper);
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
/* the page's action and the account control travel together at the trailing edge */
.topbar__trail {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  /* the editor's icon rhythm, so the two bars share one spacing */
  gap: var(--space-2);
}
/* A word ends flush at its last letter; an icon button carries --space-2 of padding
   INSIDE its 32px box. One uniform gap therefore reads uneven — with 8px, two glyphs
   sit 24px apart while a word sits 16px from the glyph beside it, which is what you
   see rather than what the CSS says. The word gets the difference back, so every gap
   in the row is 24px of actual air. */
.topbar__trail :slotted(.btn--link) {
  margin-right: var(--space-2);
}
</style>
