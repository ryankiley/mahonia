<script setup lang="ts">
import { Globe } from "@lucide/vue";
import type { ListSnapshot } from "~~/shared/types";

const route = useRoute();
const slug = computed(() => String(route.params.slug || ""));

// SSR fetch so the shared link is readable before hydration AND indexable.
// Computed URL + derived snapshot: a string URL is frozen at call time (per the
// useFetch docs) and a one-time ref copy goes stale — this way an in-app
// /l/a → /l/b navigation refetches and the page tracks the response.
const { data } = await useFetch<{ list: ListSnapshot }>(() => `/api/l/${slug.value}`);
const snapshot = computed<ListSnapshot | null>(() => data.value?.list ?? null);

// edge-cache the HTML for a short window (SSR + Cache-Control, per the plan).
useResponseHeader("Cache-Control").value =
  "public, max-age=0, s-maxage=30, stale-while-revalidate=120";

const { unit, totals, roList, ungrouped, shownFolders } = useReadonlyList(snapshot);

// SEO — indexable (NOT noindex, unlike /s/[code]). Summary shared via useReadonlyListSeo;
// `facets` comes back for the <head> template below. Only the canonical link differs.
const { facets } = useReadonlyListSeo(snapshot, totals, "public");
useHead(() => ({
  title: snapshot.value ? `${snapshot.value.title} — Mahonia` : "List not found — Mahonia",
  link: [{ rel: "canonical", href: `/l/${slug.value}` }],
}));
// "Report list" lives in the ⋯ menu (ReadonlyMenu) now — shared with /s and gated
// on isPublic there — so this page no longer carries its own report affordance.
</script>

<template>
  <div>
    <ReadTopbar :snapshot="snapshot" :totals="totals" />

    <ReadonlyListView
      :list="roList"
      :totals="totals"
      :shown-folders="shownFolders"
      :ungrouped="ungrouped"
      @set-unit="(u) => (unit = u)"
    >
      <!-- 14 = the small icon tier, the size every other inline-with-text icon uses -->
      <template #status><Globe :size="14" :stroke-width="2" /> Public list</template>

      <template #head>
        <div class="view__head">
          <h1 class="t-title view__title">{{ roList!.title }}</h1>
          <p v-if="facets.length" class="t-sm t-muted view__facets">{{ facets.join(" · ") }}</p>
          <p v-if="roList!.description" class="t-muted view__desc">{{ roList!.description }}</p>
        </div>
      </template>

      <template #missing>This list isn’t public (or doesn’t exist).</template>
    </ReadonlyListView>
  </div>
</template>

<style scoped>
.view__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* near-dup of ReadonlyListView's rule, but load-bearing: the #head slot's h1 is
   THIS page's scoped content, out of reach of ReadonlyListView's scoped copy
   (which styles only its own /s fallback heading) */
.view__title {
  font-family: var(--font);
}
.view__desc {
  max-width: 60ch;
}
</style>
