<script setup lang="ts">
import { Flag, Globe } from "@lucide/vue";
import type { ListSnapshot } from "~~/shared/types";

const route = useRoute();
const slug = String(route.params.slug || "");

// SSR fetch so the shared link is readable before hydration AND indexable.
const { data } = await useFetch<{ list: ListSnapshot }>(`/api/l/${slug}`);
const snapshot = ref<ListSnapshot | null>(data.value?.list ?? null);

// edge-cache the HTML for a short window (SSR + Cache-Control, per the plan).
useResponseHeader("Cache-Control").value =
  "public, max-age=0, s-maxage=30, stale-while-revalidate=120";

const { unit, totals, roList, ungrouped, shownFolders } = useReadonlyList(snapshot);

// SEO — indexable (NOT noindex, unlike /s/[code]). Summary shared via useReadonlyListSeo;
// `facets` comes back for the <head> template below. Only the canonical link differs.
const { facets } = useReadonlyListSeo(snapshot, totals, "public");
useHead({
  title: () => (snapshot.value ? `${snapshot.value.title} — Mahonia` : "List not found — Mahonia"),
  link: [{ rel: "canonical", href: `/l/${slug}` }],
});

// Report — flag for review (hides from the feed pending moderation).
const reported = ref(false);
const reporting = ref(false);
async function report() {
  if (reported.value || reporting.value) return;
  if (!confirm("Report this list as spam or inappropriate? It will be hidden from the feed pending review.")) return;
  reporting.value = true;
  try {
    await $fetch("/api/lists/report", { method: "POST", body: { slug } });
    reported.value = true;
  } catch {
    /* swallow — the affordance is best-effort */
  } finally {
    reporting.value = false;
  }
}
</script>

<template>
  <div>
    <SiteTopbar compact>
      <span class="t-sm t-muted topbar__tag"><Globe :size="13" :stroke-width="2" /> Public list</span>
      <NuxtLink to="/" class="btn btn--link">Make your own</NuxtLink>
    </SiteTopbar>

    <ReadonlyListView
      :list="roList"
      :totals="totals"
      :shown-folders="shownFolders"
      :ungrouped="ungrouped"
      @set-unit="(u) => (unit = u)"
    >
      <template #head>
        <div class="view__head">
          <h1 class="t-title view__title">{{ roList!.title }}</h1>
          <p v-if="facets.length" class="t-sm t-muted view__facets">{{ facets.join(" · ") }}</p>
          <p v-if="roList!.description" class="t-muted view__desc">{{ roList!.description }}</p>
        </div>
      </template>

      <template #footer>
        <footer class="view__footer">
          <button v-if="!reported" class="btn btn--sm btn--ghost view__report" :disabled="reporting" @click="report">
            <Flag :size="13" /> Report list
          </button>
          <span v-else class="t-sm t-muted">Reported — thanks, we’ll take a look.</span>
        </footer>
      </template>

      <template #missing>This list isn’t public (or doesn’t exist).</template>
    </ReadonlyListView>
  </div>
</template>

<style scoped>
.topbar__tag {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.view__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.view__title {
  font-family: var(--font);
}
.view__desc {
  max-width: 60ch;
}
.view__footer {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line);
}
.view__report {
  color: var(--ink-3);
}
.view__report:hover {
  color: var(--ink);
}
</style>
