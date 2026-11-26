<script setup lang="ts">
// /account — an ADDRESS, not a page.
//
// The account is a dialog (useAccountModal), opened over whatever you were doing. This
// route used to draw the same form bare on a page of its own for the arrivals with
// nothing underneath: a bookmark, a typed or shared URL, the assistant connector's
// "make a token at /account". That was a second design for one form, centred where the
// dialog reads from the left, and every change to one had to be made to look right in
// the other. So the address now opens the dialog over the bare address's page, which is
// the list you opened last or a fresh one (app/middleware/resume.ts).
//
// From onMounted, which is the browser and never the server: the dialog's state is one
// module-level variable, and useAccountModal says why the server must never set it.
// What the server renders for this address is the bar and an empty page, for the moment
// before that.
useHead({
  title: "Your account — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});
const { open } = useAccountModal();
onMounted(async () => {
  open();
  await navigateTo("/", { replace: true });
});
</script>

<template>
  <div>
    <SiteTopbar />
    <main id="main-content" tabindex="-1" class="wrap page" />
  </div>
</template>
