<script setup lang="ts">
import type { NuxtError } from "#app";
import { IconDirection1, IconExclamationTriangle } from "~/icons/central";

// Site-styled error page. Its other job is weight: providing app/error.vue
// keeps Nuxt's stock error-404/error-500 templates (+ their Tailwind-flavored
// CSS — ~4 KB brotli of client bundle) out of the build entirely, and renders
// errors in the site's own monochrome language instead of Nuxt's.
const props = defineProps<{ error: NuxtError }>();

const notFound = computed(() => props.error?.statusCode === 404);

useHead({
  title: computed(() =>
    notFound.value ? "Page not found — Mahonia" : "Error — Mahonia",
  ),
});

// surface the raw error in dev builds only (the branch compiles out of prod)
const dev = import.meta.dev;
</script>

<template>
  <!-- In the default layout like every other page: Nuxt renders error.vue OUTSIDE
       app.vue's <NuxtLayout>, so without this the 404 had no footer and no skip link,
       though the layout was written with it in mind ("legal/404"). Named, because an
       unnamed one takes the failed route's: the editor and the home page have none. -->
  <NuxtLayout name="default">
    <!-- The status as the bar's section label, beside the wordmark where every page
         names itself. It sat in the trailing slot, where it read as "404 Sign in". -->
    <SiteTopbar :label="String(error?.statusCode ?? 'Error')" />

    <!-- a signpost for a wrong turn, a warning for a fault -->
    <MessagePage :icon="notFound ? IconDirection1 : IconExclamationTriangle">
      <h1 class="t-title">
        {{ notFound ? "This page doesn’t exist." : "Something went wrong." }}
      </h1>
      <p>
        {{
          notFound
            ? "The link may be mistyped, or the list behind it may have been deleted."
            : "An unexpected error got in the way. Reloading usually clears it."
        }}
      </p>
      <!-- its own way on: the same words, but leaving clears the error -->
      <template #action>
        <button
          class="btn btn--primary"
          type="button"
          @click="clearError({ redirect: '/e' })"
        >
          Create a list
        </button>
      </template>
      <!-- not for a 404: its stack is the router saying "no such page", and in dev it
             buried the page under half a screen of node_modules paths -->
      <template #after>
        <pre v-if="dev && !notFound" class="t-sm err__dump">{{ error }}</pre>
      </template>
    </MessagePage>
  </NuxtLayout>
  <!-- Nuxt renders this page INSTEAD of app.vue, so it mounts the app-wide overlays
       itself: without them the top bar's Sign in opened nothing, then popped up
       unasked once a link left the error. -->
  <AppOverlays />
</template>

<style scoped>
/* Centred both ways by .page--alone (main.scss), which the other pages that are one
   message and one way on wear too. */
/* Dev only. The stack is one long line, and a bare <pre> ran it off the page. Read as
   code, left-aligned, across the column. */
.err__dump {
  align-self: stretch;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
