<script setup lang="ts">
import { seasonLabel, tripTypeLabel } from "~~/shared/discovery";
import type { ListSnapshot } from "~~/shared/types";
import { formatWeightAuto } from "~~/shared/weights";

const route = useRoute();
const code = String(route.params.code || "");

// SSR fetch so a shared link is readable before hydration + indexable structure.
const { data } = await useFetch<{ snapshot: ListSnapshot }>(`/api/s/${code}`);
const snapshot = ref<ListSnapshot | null>(data.value?.snapshot ?? null);

const { unit, totals, roList, ungrouped, shownFolders } = useReadonlyList(snapshot);

// Social unfurl (iMessage/Slack/etc.): the title + a short summary so a pasted
// share link shows the list name, not a bare URL. noindex (below) keeps it out of
// search; og tags still drive link previews regardless.
const facets = computed(
  () =>
    [tripTypeLabel(snapshot.value?.tripType), seasonLabel(snapshot.value?.season)].filter(
      Boolean,
    ) as string[],
);
const desc = computed(() => {
  if (!snapshot.value || !totals.value) return "A shared packing list on Mahonia.";
  const bits = [`${totals.value.itemCount} items`];
  if (facets.value.length) bits.unshift(facets.value.join(", "));
  if (totals.value.hasWeights)
    bits.push(`${formatWeightAuto(totals.value.baseMg)} base weight`);
  return `${snapshot.value.title} — a shared packing list (${bits.join(" · ")}). Make your own on Mahonia.`;
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
