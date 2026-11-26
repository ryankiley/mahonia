<script setup lang="ts">
// The bare editor route (a fresh draft, or an existing list via /e#{token}).
// Lives at pages/e/index.vue (NOT pages/e.vue) so it's a SIBLING of the named-link
// route pages/e/[code].vue — a pages/e.vue would make /e/{code} a nested child that
// only renders through a <NuxtPage/>, suppressing that route's own head/data.
//
// The whole editor surface, including its own topbar, lives in
// <GearEditor>, a .client component, so the body only ever runs in the browser.
definePageMeta({ layout: false });

// /e#{token}, a list from before share codes: held like /e/{code}, and like it not
// while hydrating — see readAhead and pages/e/[code].vue
if (import.meta.client && !useNuxtApp().isHydrating) await readAhead(useRoute());
</script>

<template>
  <GearEditor />
</template>
