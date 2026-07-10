<script setup lang="ts">
// The bare editor route (a fresh draft, or an existing list via /e#{token}).
// Lives at pages/e/index.vue (NOT pages/e.vue) so it's a SIBLING of the named-link
// route pages/e/[code].vue — a pages/e.vue would make /e/{code} a nested child that
// only renders through a <NuxtPage/>, suppressing that route's own head/data.
//
// The whole editor surface — its own topbar + the shared SiteFooter — lives in
// <GearEditor>, a .client component, so the body only ever runs in the browser.
definePageMeta({ layout: false });
</script>

<template>
  <GearEditor />
</template>
