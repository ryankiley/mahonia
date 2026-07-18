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

// edge-cache the HTML for a short window, mirroring /l — collapses the burst when
// a share link makes the rounds; a read-only view tolerates 30 s of staleness.
useResponseHeader("Cache-Control").value =
  "public, max-age=0, s-maxage=30, stale-while-revalidate=120";

const { unit, totals, roList, ungrouped, shownFolders } = useReadonlyList(snapshot);

// Social unfurl (iMessage/Slack/etc.): the title + a short summary so a pasted share
// link shows the list name, not a bare URL. Shared with /l via useReadonlyListSeo;
// this page's noindex (below) keeps it out of search — og tags still drive previews.
useReadonlyListSeo(snapshot, totals, "shared");
useHead({
  title: () => (snapshot.value ? `${snapshot.value.title} — Mahonia` : "Mahonia"),
  meta: [{ name: "robots", content: "noindex" }],
});
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
      <template #status>Read-only</template>
    </ReadonlyListView>
  </div>
</template>
