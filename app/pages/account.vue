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
      <AccountView />
    </main>
  </div>
</template>
