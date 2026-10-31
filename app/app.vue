<script setup lang="ts">
const { state: accountModal } = useAccountModal();
const { mount: dialogs } = useDialogs();
const { state: feedback, close: closeFeedback } = useFeedback();
// One mount outlives any page, where the two per-surface mounts it replaced went with
// theirs — so a route change (Back, with the box open) closes it, as it always did.
const route = useRoute();
watch(() => route.path, closeFeedback);
// The static social-card IMAGE — the fallback every page carries until a
// list page overrides it with its own card (useListOgCard). Absolute via
// useSiteOrigin, which owns the prerender-crawler guard this file used to
// carry. unhead dedupes this over the static fallback in nuxt.config
// wherever SSR runs.
const ogImage = `${useSiteOrigin()}/og.png`;

useSeoMeta({
  ogImage,
  // 1200×630 literals, NOT imports from shared/ogCard: app.vue is the entry
  // chunk, and hauling that module (and the weights it pulls) up here is the
  // exact bundle mistake editorSeo.ts documents avoiding
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: "image/png",
  ogImageAlt: "The Mahonia M. Pack lists, weighed.",
  twitterImage: ogImage,
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <!-- One app-wide mount, like AppDialogs: any component can open the account without
       wiring its own overlay. Lazy + everOpened, so a visit that never opens it pays
       nothing for the panel, the passkey ceremony or the delete flow. -->
  <LazyAccountModal v-if="accountModal.everOpened" />
  <!-- the feedback box, the same way: the editor's ⋯ menu and the read views' both
       open it (useFeedback), and the read views' "Report list" seeds it -->
  <LazyFeedbackModal
    v-if="feedback.everOpened"
    :open="feedback.open"
    :preset="feedback.preset"
    :title="feedback.title"
    @close="feedback.open = false"
  />
  <!-- LAST, and that's load-bearing. Every overlay shares one --z-float, so paint
       order decides which is on top — and a confirm can be raised from inside another
       modal (delete-account is raised from the account modal). Anything mounted after
       AppDialogs would cover the question it was asked to answer. Lazy + everOpened
       like the account modal above (the confirm and the copy fallback both open on a
       click and nothing else); a v-if keeps its place in the order, so mounting late
       still lands it last. -->
  <LazyAppDialogs v-if="dialogs.everOpened" />
</template>
