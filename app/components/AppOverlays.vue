<script setup lang="ts">
// The app-wide overlays, mounted once by app.vue and once by error.vue (which Nuxt
// renders INSTEAD of app.vue), so both pages mount the same ones in the same order.
// Each is Lazy + everOpened: any component can open one without wiring its own
// overlay, and a visit that never opens it pays nothing for it.
const { state: accountModal } = useAccountModal();
const { mount: dialogs } = useDialogs();
// its state file only: the link's logic stays out of every page's first load
const signInLink = useSignInLinkState();
const { state: feedback, close: closeFeedback } = useFeedback();
// One mount outlives any page, so a route change (Back, with the box open) closes the
// feedback box rather than carrying it onto the next page.
const route = useRoute();
watch(() => route.path, closeFeedback);
</script>

<template>
  <!-- the account panel, the passkey ceremony and the delete flow -->
  <LazyAccountModal v-if="accountModal.everOpened" />
  <!-- what a sign-in link may need to ask, over the page it was asked from
       (useSignInLink): mounted only for a link that has a question -->
  <LazySignInLinkDialog v-if="signInLink.everOpened" />
  <!-- the feedback box: the editor's, the read views' and My Gear's ⋯ menus open it
       (useFeedback), and the read views' "Report list" seeds it -->
  <LazyFeedbackModal
    v-if="feedback.everOpened"
    :open="feedback.open"
    :preset="feedback.preset"
    :title="feedback.title"
    @close="closeFeedback"
  />
  <!-- LAST, and that's load-bearing. Every overlay shares one --z-float, so paint
       order decides which is on top, and a confirm can be raised from inside another
       modal (delete-account is raised from the account modal). Anything mounted after
       AppDialogs would cover the question it was asked to answer. A v-if keeps its
       place in the order, so mounting late still lands it last. -->
  <LazyAppDialogs v-if="dialogs.everOpened" />
</template>
