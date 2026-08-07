<script setup lang="ts">
// The one site-wide footer — a slim legal line, mounted by the default layout and
// the editor so every page gets the exact same footer. Just the legal links + the
// copyright; contact lives on the About page, not here. Monochrome chrome.
const year = new Date().getFullYear();

// `inToolbar` is set by the EDITOR, which carries "Your lists" (the switcher) and
// "My gear" in its own top bar. Repeating them three inches below is a second
// copy of a control you can already see. Deliberately a prop rather than a route
// check: the footer shouldn't know which pages exist, and a page that later grows
// its own toolbar can say so the same way.
//
// NOT viewport-conditional, unlike an earlier attempt with a desktop-only side
// panel: both toolbar affordances are present at every width, so the footer can
// drop them at every width too.
const { inToolbar = false } = defineProps<{ inToolbar?: boolean }>();

// "My gear" is signed-in chrome; "Your lists" is not. The asymmetry is the
// product's, not a hedge: lists need no account and live in a device-local
// registry, so a signed-out visitor is exactly the person who might have some —
// while the vault IS the account (see useSession: it's the only reason accounts
// exist). Offering a stranger "your" vault on a friend's shared list points at
// something that cannot exist yet.
//
// Gated on the HINT COOKIE, not on `signedIn`. Nothing on a read view ever calls
// useSession().fetch() — AccountMenu, the only session reader in the topbar,
// deliberately doesn't — so `signedIn` is false on /s and /l even for someone
// signed in, which is the one case this must get right. The hint carries no
// capability; being wrong costs a link to a page that explains itself.
const { signedIn, hasSessionHint } = useSession();
const known = ref(false);
onMounted(() => (known.value = hasSessionHint() || signedIn.value));
watch(signedIn, (yes) => (known.value = yes || hasSessionHint()));

// Never link to the page you're already on — it reads as an action and does nothing,
// and in a four-link row it costs one of the four. AccountMenu has applied this to its
// own two destinations from the start; the footer simply never got it, so /about
// offered "About" and /mine offered "Your lists". Compared on `path`, not fullPath, so
// a query or hash on the current page doesn't make the self-link reappear.
const route = useRoute();
const here = (p: string) => route.path === p;

// No feedback trigger here any more — it lives in the editor's actions menu. The
// footer is a legal line: four places to go and a copyright. A dialog launcher styled
// to pass as a link in that row was the odd one out, and "send feedback" belongs
// beside the thing you'd be reporting on rather than under it.
</script>

<template>
  <footer class="foot">
    <div class="wrap foot__inner">
      <nav class="foot__nav" aria-label="Footer">
        <!-- "My gear" is the surface's name, not a possessive stacked on one, so it
             doesn't repeat the "Your" beside it — which is what made an earlier
             "Your lists / Your vault" pair read as a set apart from About and Legal.
             /mine keeps its original label.
             The vault link appears only for an account (see `known` above); /mine is
             unconditional, since lists never needed one. Neither is gated on whether
             you HOLD lists or gear — both pages explain themselves when empty, and
             that read is device-local, so gating on it would flicker for no gain. -->
        <NuxtLink v-if="!inToolbar && !here('/mine')" to="/mine" class="foot__link t-sm">Your lists</NuxtLink>
        <NuxtLink v-if="!inToolbar && known && !here('/vault')" to="/vault" class="foot__link t-sm">My gear</NuxtLink>
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
