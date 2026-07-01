<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";

const route = useRoute();
const code = String(route.params.code || "");

// SSR fetch so a shared link is readable before hydration + indexable structure.
const { data } = await useFetch<{ snapshot: ListSnapshot }>(`/api/s/${code}`);
const snapshot = ref<ListSnapshot | null>(data.value?.snapshot ?? null);

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
    <SiteTopbar compact>
      <span class="t-sm t-muted">Read-only</span>
      <NuxtLink to="/" class="btn btn--link">Make your own</NuxtLink>
    </SiteTopbar>

    <ReadonlyListView
      :list="roList"
      :totals="totals"
      :shown-folders="shownFolders"
      :ungrouped="ungrouped"
      @set-unit="(u) => (unit = u)"
    />
  </div>
</template>
