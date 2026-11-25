<script setup lang="ts">
// /account — the account surface as a PAGE.
//
// In the app the account opens as a MODAL over whatever you were doing
// (useAccountModal), because signing in is a toll paid on the way to something else,
// not a place you meant to go. This route still exists for the three ways in that
// have no "whatever you were doing" underneath: a bookmark, a typed or shared URL,
// and the "Get a new link" button on a dead magic link.
//
// Same component either way — see AccountView.
// Head lives on the PAGE, never in AccountView: the component also mounts inside the
// account modal, over some other page, and a head call there would retitle that page
// and stamp this noindex onto it.
useHead({
  title: "Your account — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});
</script>

<template>
  <div>
    <SiteTopbar />
    <main id="main-content" tabindex="-1" class="wrap page">
      <AccountView class="account__col" />
    </main>
  </div>
</template>

<style scoped>
/* The page's column, centred in the page as About, Help and Legal centre theirs
   (.prose, main.scss, says why a left-parked column reads as a layout fault). The
   width is the signed-in column's own (.acct__body), so the heading and the sections
   keep one left edge; the signed-out column is narrower and already centres inside.
   Here and not in AccountView, which the account dialog and /authorize also mount. */
.account__col {
  max-width: 52ch;
  margin-inline: auto;
}
</style>
