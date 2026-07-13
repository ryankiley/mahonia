<script setup lang="ts">
// The social-card IMAGE, request-derived so SSR routes (/s, /l) reference their
// own deploy host — portable like the sitemap, no hardcoded URL. unhead dedupes
// this over the static fallback in nuxt.config wherever SSR runs.
//
// PRERENDERED routes (/e, the legal pages) are the exception: the build
// crawler's request origin would bake a broken absolute http://localhost/og.jpg
// into the static HTML — so they pin the canonical origin instead. The crawler
// is identified by its PORTLESS http://localhost origin (a real local server
// always carries a port; import.meta.prerender is NOT substituted in app code —
// verified against the built output, which still carried localhost with it).
const requestOrigin = useRequestURL().origin;
const origin = requestOrigin === "http://localhost" ? CANONICAL_ORIGIN : requestOrigin;
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
  <AppDialogs />
</template>
