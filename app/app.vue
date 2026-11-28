<script setup lang="ts">
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
  <AppOverlays />
</template>
