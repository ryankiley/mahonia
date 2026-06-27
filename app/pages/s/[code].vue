<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";

const route = useRoute();
const code = String(route.params.code || "");

// SSR fetch so a shared link is readable before hydration + indexable structure.
const { data } = await useFetch<{ snapshot: ListSnapshot }>(`/api/s/${code}`);
const snapshot = ref<ListSnapshot | null>(data.value?.snapshot ?? null);

const { unit, totals, roList, ungrouped, shownFolders } = useReadonlyList(snapshot);

useHead({
  title: () => (snapshot.value ? `${snapshot.value.title} — Mahonia` : "Mahonia"),
  meta: [{ name: "robots", content: "noindex" }],
});

// Live-sync: poll for the owner's edits; pause when the tab is hidden.
let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  poll = setInterval(async () => {
    if (document.hidden || !snapshot.value) return;
    try {
      const res = await $fetch<{ version: number; snapshot?: ListSnapshot }>(
        `/api/s/${code}/changes`,
        { query: { since: snapshot.value.version } },
      );
      if (res.snapshot) snapshot.value = res.snapshot;
    } catch {
      /* transient */
    }
  }, 3000);
});
onBeforeUnmount(() => poll && clearInterval(poll));
</script>

<template>
  <div>
    <SiteTopbar compact>
      <span class="t-sm t-muted">Read-only</span>
      <NuxtLink to="/" class="btn btn--sm">Make your own</NuxtLink>
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
