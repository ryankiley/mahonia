<template>
  <!-- Column shell so the footer sits at the bottom on short pages (legal/404)
       and below the content on long ones. Auto-applied to every page. -->
  <div class="shell">
    <!-- Skip link — the first thing in the tab order on every page, so a keyboard
         or screen-reader user isn't walked through the topbar's controls before
         reaching the list. A real href (not a JS focus handler) so it also works on
         the share views, which render server-side and are readable without JS.
         Every page's own <main> carries the matching id + tabindex="-1", so
         following it moves the caret and not just the scroll position. -->
    <a class="skip" href="#main-content">Skip to content</a>
    <div class="shell__main">
      <slot />
    </div>
    <SiteFooter />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100svh;
}
.shell__main {
  flex: 1 0 auto;
}
/* Off-screen until focused, then it lands as a normal button-ish chip in the top
   left. Not .visually-hidden: that utility can't un-hide on focus, and this must
   become VISIBLE when tabbed to (a skip link nobody can see is the classic
   half-implementation). Sits above the sticky topbar's --z-topbar. */
.skip {
  position: fixed;
  /* --space-4 (not --space-2): the focus ring is drawn OUTSIDE the pill, and at an
     8px offset it clipped against the viewport edge */
  top: var(--space-4);
  left: var(--space-4);
  z-index: calc(var(--z-topbar) + 1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--accent-ink);
  /* translate rather than display:none — a hidden element isn't focusable, and
     `left: -9999px` fights the safe-area gutter on notched phones */
  transform: translateY(calc(-100% - var(--space-4)));
  transition: transform var(--dur) var(--ease);
}
.skip:focus-visible {
  transform: translateY(0);
}
/* reduced-motion is handled by the global duration kill-switch (main.scss) */
</style>
