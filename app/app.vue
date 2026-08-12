<script setup lang="ts">
const { state: accountModal } = useAccountModal();
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
  <!-- LAST, and that's load-bearing. Every overlay shares one --z-float, so paint
       order decides which is on top — and a confirm can be raised from inside another
       modal (delete-account is raised from the account modal). Anything mounted after
       AppDialogs would cover the question it was asked to answer. -->
  <AppDialogs />
</template>
