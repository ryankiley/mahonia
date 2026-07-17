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
</script>

<template>
  <div>
    <SiteTopbar>
      <span class="t-sm t-muted">{{ error?.statusCode ?? "Error" }}</span>
    </SiteTopbar>

    <main class="wrap page">
      <div class="prose">
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
          <button class="btn btn--primary" type="button" @click="clearError({ redirect: '/' })">
            Start a packing list
          </button>
        </p>
        <pre v-if="dev" class="t-sm">{{ error }}</pre>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page {
  padding-block: var(--space-5) var(--space-9);
}
</style>
