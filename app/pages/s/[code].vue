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

const { unit, totals, roList, ungrouped, shownFolders } = useReadonlyList(snapshot);

// Social unfurl (iMessage/Slack/etc.): the title + a short summary so a pasted
// share link shows the list name, not a bare URL. noindex (below) keeps it out of
// search; og tags still drive link previews regardless.
const { desc } = useReadonlyListSeo(snapshot, totals, {
  kind: "shared",
  cta: "Make your own on Mahonia.",
});
useHead({
  title: () => (snapshot.value ? `${snapshot.value.title} — Mahonia` : "Mahonia"),
  meta: [{ name: "robots", content: "noindex" }],
});
useSeoMeta({
  description: () => desc.value,
  ogTitle: () => (snapshot.value ? snapshot.value.title : "Mahonia"),
  ogDescription: () => desc.value,
  ogType: "article",
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
