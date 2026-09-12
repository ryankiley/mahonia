<script setup lang="ts">
// A slim navigation line for non-editor pages, mounted by the default layout.
// The editor keeps these destinations in its top-right menu to leave its canvas open.

// The footer reads NO session state, and that is the point of it. It used to, for
// one link: "My Gear" is signed-in chrome, so it needed the hint cookie to know
// whether to offer a page that cannot exist for a stranger. With that link gone —
// a footer is legal-and-colophon chrome, the wrong shelf for one person's own
// possessions — the whole apparatus goes with it: the session read, the hint
// fallback for the read views, and the `inToolbar` prop the editor passed to stop
// the footer repeating its own toolbar. Copyright now lives on About.

// Never link to the page you're already on — it reads as an action and does nothing,
// and in a short row it costs one of the few. AccountMenu has applied this to its own
// two destinations from the start; the footer simply never got it, so /about offered
// "About". Compared on `path`, not fullPath, so a query or hash on the current page
// doesn't make the self-link reappear.
const route = useRoute();
const here = (p: string) => route.path === p;

// No feedback trigger here any more — it lives in the editor's actions menu. A
// dialog launcher styled to pass as a link in this row was the odd one out; feedback belongs
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
             glyph in the editor, and the account menu on every other page. "What's
             new" went when the changelog became GitHub's Releases; About points there. -->
        <NuxtLink v-if="!here('/about')" to="/about" class="foot__link t-sm">About</NuxtLink>
        <NuxtLink v-if="!here('/legal')" to="/legal" class="foot__link t-sm">Legal</NuxtLink>
      </nav>
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
</style>
