<script setup lang="ts">
// The bare editor route (a fresh draft, or an existing list via /e#{token}).
// Lives at pages/e/index.vue (NOT pages/e.vue) so it's a SIBLING of the named-link
// route pages/e/[code].vue — a pages/e.vue would make /e/{code} a nested child that
// only renders through a <NuxtPage/>, suppressing that route's own head/data.
//
// The whole editor surface, including its own topbar, lives in
// <GearEditor>, a .client component, so the body only ever runs in the browser.
definePageMeta({ layout: false });

// Offline, this page also stands in for /e/{code} (config/pwa.ts) until the router
// moves to that address (app/plugins/pwa.client.ts). It must mount nothing in the
// meantime: an editor here would start a draft and tear it down again, writing over
// the on-device draft slot. A bare div matches the server's client-only placeholder.
const standingIn = import.meta.client && !!useShellFallback().value;
</script>

<template>
  <div v-if="standingIn" />
  <GearEditor v-else />
</template>
