<script setup lang="ts">
// The one site-wide footer — a slim legal line, mounted by the default layout and
// the editor so every page gets the exact same footer. Just the legal links + the
// copyright; contact lives on the About page, not here. Monochrome chrome.
const year = new Date().getFullYear();

// The footer reads NO session state, and that is the point of it. It used to, for
// one link: "My Gear" is signed-in chrome, so it needed the hint cookie to know
// whether to offer a page that cannot exist for a stranger. With that link gone —
// a footer is legal-and-colophon chrome, the wrong shelf for one person's own
// possessions — the whole apparatus goes with it: the session read, the hint
// fallback for the read views, and the `inToolbar` prop the editor passed to stop
// the footer repeating its own toolbar. Two links about the site, and a copyright.

// Never link to the page you're already on — it reads as an action and does nothing,
// and in a short row it costs one of the few. AccountMenu has applied this to its own
// two destinations from the start; the footer simply never got it, so /about offered
// "About". Compared on `path`, not fullPath, so a query or hash on the current page
// doesn't make the self-link reappear.
const route = useRoute();
const here = (p: string) => route.path === p;

// No feedback trigger here any more — it lives in the editor's actions menu. The
// footer is a legal line: a few places to go and a copyright. A dialog launcher styled
// to pass as a link in that row was the odd one out, and "send feedback" belongs
// beside the thing you'd be reporting on rather than under it.
</script>

<template>
  <footer class="foot">
    <div class="wrap foot__inner">
      <nav class="foot__nav" aria-label="Footer">
        <!-- Two links, and both are about the SITE. "Your lists" used to sit here and
             went when its page did; "My Gear" followed it for the same reason — a
             footer is legal-and-colophon chrome, which is the wrong shelf for one
             person's own possessions. It lives where you use it now: the toolbar
             glyph in the editor, and the account menu on every other page. -->
        <NuxtLink v-if="!here('/about')" to="/about" class="foot__link t-sm">About</NuxtLink>
        <NuxtLink v-if="!here('/legal')" to="/legal" class="foot__link t-sm">Legal</NuxtLink>
      </nav>

      <p class="t-sm t-muted foot__copy">© {{ year }} Mahonia</p>
    </div>
  </footer>
</template>

<style scoped>
.foot {
  /* the single content→footer gap, site-wide — matches the inter-folder rhythm
     (--space-7). Page containers add no bottom padding, so this isn't doubled. */
  margin-top: var(--space-7);
}
/* The rule is on the INNER column, not the outer block: it marks where the page's
   content ends, so it should measure the content — not run the width of whatever
   shell the page happens to sit in. */
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
</style>
