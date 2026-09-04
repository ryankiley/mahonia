<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";

const route = useRoute();
const code = computed(() => String(route.params.code || ""));

// SSR fetch so a shared link is readable before hydration + indexable structure.
// Computed URL + derived snapshot: a string URL is frozen at call time (per the
// useFetch docs) and a one-time ref copy goes stale — this way an in-app
// /s/a → /s/b navigation refetches and the page tracks the response.
const { data } = await useFetch<{ snapshot: ListSnapshot }>(() => `/api/s/${code.value}`);
const snapshot = computed<ListSnapshot | null>(() => data.value?.snapshot ?? null);

// The edge-cache window, the view-model and the social unfurl (iMessage/Slack/etc.:
// the title + a short summary so a pasted share link shows the list name, not a bare
// URL) are shared with /l via useReadonlyPage; this page's noindex (below) keeps it
// out of search — og tags still drive previews.
const { unit, fullTotals, personFilter, view } = useReadonlyPage(snapshot, "shared");
useHead({
  title: () => (snapshot.value ? `${snapshot.value.title} — Mahonia` : "Mahonia"),
  meta: [{ name: "robots", content: "noindex" }],
});
</script>

<template>
  <div>
    <!-- fullTotals, not totals: the topbar's figure (and the weight a Duplicate
         registers in "Your lists") describes the list, not the viewer's filter -->
    <ReadTopbar :snapshot="snapshot" :totals="fullTotals" />

    <!-- No #status here: a share link carries nothing to edit with, so "Read-only" only
         ever told the reader what the page already shows. /l keeps its status, because
         "Public list" says something the page doesn't — that this list is listed. -->
    <ReadonlyListView
      v-bind="view"
      @set-unit="(u) => (unit = u)"
      @pick-person="(id) => (personFilter = id)"
    />
  </div>
</template>
