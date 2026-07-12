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

// "Copy this list" — the viewer takes an independent, editable copy of what
// they're looking at (the share-a-template loop). Same path as the editor's
// Duplicate; lands in the copy's editor on success.
const { copying, copyList } = useCopyList();
const copyFailed = ref(false);
async function onCopy() {
  if (!snapshot.value) return;
  copyFailed.value = !(await copyList(snapshot.value, totals.value?.totalMg ?? 0));
}
const copyLabel = computed(() =>
  copying.value ? "Copying…" : copyFailed.value ? "Couldn’t copy — retry" : "Copy this list",
);

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
      <span class="t-sm t-muted topbar__tag">Read-only</span>
      <span class="topbar__actions">
        <button
          v-if="snapshot"
          type="button"
          class="btn btn--link"
          :disabled="copying"
          @click="onCopy"
        >{{ copyLabel }}</button>
        <NuxtLink to="/" class="btn btn--link">Make your own</NuxtLink>
      </span>
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

<style scoped>
/* the two CTAs travel together at the trailing edge (the wrapper takes the auto
   margin the topbar would otherwise give each .btn, which would spread them out) */
.topbar__actions {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
