<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { GlobeIcon } from "@hugeicons/core-free-icons";
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

const { unit, fullTotals, roList, personFilter, viewProps } = useReadonlyList(snapshot);

// SEO — indexable (NOT noindex, unlike /s/[code]). Summary shared via useReadonlyListSeo;
// `facets` comes back for the <head> template below. Only the canonical link differs.
// fullTotals, not totals: search/unfurls describe the list, not the viewer's filter.
const { facets } = useReadonlyListSeo(snapshot, fullTotals, "public");
useHead(() => ({
  title: snapshot.value ? `${snapshot.value.title} — Mahonia` : "List not found — Mahonia",
  link: [{ rel: "canonical", href: `/l/${slug.value}` }],
}));
// "Report list" lives in the ⋯ menu (ReadonlyMenu) now — shared with /s and gated
// on isPublic there — so this page no longer carries its own report affordance.
</script>

<template>
  <div>
    <!-- fullTotals, not totals: the topbar's figure (and the weight a Duplicate
         registers in "Your lists") describes the list, not the viewer's filter -->
    <ReadTopbar :snapshot="snapshot" :totals="fullTotals" />

    <!-- the view-model's props as one object (useReadonlyList.viewProps), the same
         binding /s makes -->
    <ReadonlyListView
      v-bind="viewProps"
      @set-unit="(u) => (unit = u)"
      @pick-person="(id) => (personFilter = id)"
    >
      <!-- 14 = the small icon tier, the size every other inline-with-text icon uses -->
      <template #status><HugeiconsIcon :icon="GlobeIcon" :size="14" :stroke-width="2" /> Public list</template>

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
/* the h1's page-title step (.view__title) is global — main.scss — so this page's
   #head slot and ReadonlyListView's /s fallback wear one rule */
.view__desc {
  max-width: 60ch;
}
</style>
