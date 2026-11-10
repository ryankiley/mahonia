<script setup lang="ts">
import type { NuxtError } from "#app";

// Site-styled error page. Its other job is weight: providing app/error.vue
// keeps Nuxt's stock error-404/error-500 templates (+ their Tailwind-flavored
// CSS — ~4 KB brotli of client bundle) out of the build entirely, and renders
// errors in the site's own monochrome language instead of Nuxt's.
const props = defineProps<{ error: NuxtError }>();

const notFound = computed(() => props.error?.statusCode === 404);

useHead({
  title: computed(() => (notFound.value ? "Page not found — Mahonia" : "Error — Mahonia")),
});

// surface the raw error in dev builds only (the branch compiles out of prod)
const dev = import.meta.dev;

// Nuxt renders this page INSTEAD of app.vue, so app.vue's app-wide mounts aren't here:
// without its own, the top bar's Sign in opened nothing, then popped up unasked once a
// link left the error.
const { state: accountModal } = useAccountModal();
const { mount: dialogs } = useDialogs();
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

    <main id="main-content" tabindex="-1" class="wrap page err">
      <div class="prose err__body">
        <h1 class="t-title">
          {{ notFound ? "This page doesn't exist." : "Something went wrong." }}
        </h1>
        <p>
          {{
            notFound
              ? "The link may be mistyped, or the list behind it may have been deleted."
              : "An unexpected error got in the way. Reloading usually clears it."
          }}
        </p>
        <p>
          <button class="btn btn--primary" type="button" @click="clearError({ redirect: '/e' })">
            Start a packing list
          </button>
        </p>
        <!-- not for a 404: its stack is the router saying "no such page", and in dev it
             buried the page under half a screen of node_modules paths -->
        <pre v-if="dev && !notFound" class="t-sm err__dump">{{ error }}</pre>
      </div>
    </main>
  </NuxtLayout>
  <!-- app.vue's two, in its order: the dialogs last, over the account they can be raised from -->
  <LazyAccountModal v-if="accountModal.everOpened" />
  <LazyAppDialogs v-if="dialogs.everOpened" />
</template>

<style scoped>
/* Centred both ways in the space between the top bar and the footer. The message is
   three short lines, and at the top-left of an empty page it looked like a page that
   hadn't finished loading. */
.err {
  flex: 1 0 auto;
  display: grid;
  place-items: center;
}
.err__body {
  align-items: center;
  text-align: center;
}
/* Dev only. The stack is one long line, and a bare <pre> ran it off the page. Read as
   code, left-aligned, across the column. */
.err__dump {
  align-self: stretch;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

<style>
/* Unscoped, because it reaches the layout's column, which this page doesn't own. That
   column is a plain block, so it has no height for <main> to fill. This makes it a flex
   column only while it holds the error page, and every other page is untouched. */
.shell__main:has(> .err) {
  display: flex;
  flex-direction: column;
}
</style>
