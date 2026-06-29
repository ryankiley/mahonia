<script setup lang="ts">
// The social-card IMAGE, request-derived so SSR routes (/s, /l, /about) reference their
// own deploy host — portable like the sitemap, no hardcoded URL. unhead dedupes this
// over the static fallback in nuxt.config wherever SSR runs; that static fallback is
// only what the `ssr: false` editor shell (the bare domain) can serve to crawlers.
const { origin } = useRequestURL();
const ogImage = `${origin}/og.jpg`;

useSeoMeta({
  ogImage,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: "image/jpeg",
  ogImageAlt: "Mahonia — Oregon grape in flower and fruit",
  twitterImage: ogImage,
});
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
