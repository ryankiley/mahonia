<script setup lang="ts">
import { Flag, Globe } from "@lucide/vue";
import { seasonLabel, tripTypeLabel } from "~~/shared/discovery";
import type { ListSnapshot, Unit } from "~~/shared/types";
import { computeTotals, formatWeight } from "~~/shared/weights";

const route = useRoute();
const slug = String(route.params.slug || "");

// SSR fetch so the shared link is readable before hydration AND indexable.
const { data } = await useFetch<{ list: ListSnapshot }>(`/api/l/${slug}`);
const snapshot = ref<ListSnapshot | null>(data.value?.list ?? null);

// edge-cache the HTML for a short window (SSR + Cache-Control, per the plan).
useResponseHeader("Cache-Control").value =
  "public, max-age=0, s-maxage=30, stale-while-revalidate=120";

const unit = ref<Unit>(snapshot.value?.displayUnit ?? "g");
const totals = computed(() => (snapshot.value ? computeTotals(snapshot.value) : null));
// re-skin with the viewer's chosen unit; the readonly components read displayUnit
const roList = computed(() =>
  snapshot.value ? { ...snapshot.value, displayUnit: unit.value } : null,
);
const ungrouped = computed(() =>
  snapshot.value ? snapshot.value.items.filter((i) => !i.folderId) : [],
);
const shownFolders = computed(() =>
  roList.value
    ? roList.value.folders.filter((f) => snapshot.value!.items.some((i) => i.folderId === f.id))
    : [],
);

const tripLabel = computed(() => tripTypeLabel(snapshot.value?.tripType));
const seasonName = computed(() => seasonLabel(snapshot.value?.season));
const facets = computed(() => [tripLabel.value, seasonName.value].filter(Boolean) as string[]);

// SEO — indexable (NOT noindex, unlike /s/[code]). Description summarizes the list.
const desc = computed(() => {
  if (!snapshot.value || !totals.value) return "A public packing list on Gear.";
  const bits = [`${totals.value.itemCount} items`];
  if (facets.value.length) bits.unshift(facets.value.join(", "));
  if (totals.value.hasWeights)
    bits.push(`${formatWeight(totals.value.baseMg, "g")} base weight`);
  return `${snapshot.value.title} — a public packing list (${bits.join(" · ")}). Browse gear lists on Gear.`;
});
useHead({
  title: () => (snapshot.value ? `${snapshot.value.title} — Gear` : "List not found — Gear"),
  link: [{ rel: "canonical", href: `/l/${slug}` }],
});
useSeoMeta({
  description: () => desc.value,
  ogTitle: () => (snapshot.value ? snapshot.value.title : "Gear"),
  ogDescription: () => desc.value,
  ogType: "article",
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
    <header class="topbar">
      <div class="wrap topbar__inner">
        <NuxtLink to="/" class="t-label brand">Gear</NuxtLink>
        <span class="t-sm t-muted topbar__tag"><Globe :size="13" :stroke-width="2" /> Public list</span>
        <NuxtLink to="/" class="btn btn--sm">Make your own</NuxtLink>
      </div>
    </header>

    <main v-if="roList && totals" class="wrap view">
      <div class="view__head">
        <h1 class="t-title view__title">{{ roList.title }}</h1>
        <p v-if="facets.length" class="t-sm t-muted view__facets">{{ facets.join(" · ") }}</p>
        <p v-if="roList.description" class="t-muted view__desc">{{ roList.description }}</p>
      </div>

      <TotalsBar :list="roList" :totals="totals" readonly @set-unit="(u) => (unit = u)" />

      <div class="view__folders">
        <FolderSection v-for="f in shownFolders" :key="f.id" :list="roList" :folder="f" readonly />
        <section v-if="ungrouped.length">
          <p class="t-label view__ungrouped">Ungrouped</p>
          <ItemRow v-for="it in ungrouped" :key="it.id" :list="roList" :item="it" readonly />
        </section>
      </div>

      <footer class="view__footer">
        <button v-if="!reported" class="btn btn--sm btn--ghost view__report" :disabled="reporting" @click="report">
          <Flag :size="13" /> Report list
        </button>
        <span v-else class="t-sm t-muted">Reported — thanks, we’ll take a look.</span>
      </footer>
    </main>

    <main v-else class="wrap view view--missing">
      <p class="t-muted">This list isn’t public (or doesn’t exist).</p>
      <NuxtLink to="/" class="btn btn--primary">Make a list</NuxtLink>
    </main>
  </div>
</template>

<style scoped>
.topbar {
  border-bottom: 1px solid var(--line);
}
.topbar__inner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-block: var(--space-3);
}
.brand {
  color: var(--ink);
}
.topbar__tag {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.topbar__inner .btn {
  margin-left: auto;
}
.view {
  padding-block: var(--space-5) var(--space-9);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
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
.view__folders {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}
.view__ungrouped {
  margin-bottom: var(--space-1);
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
.view--missing {
  padding-block: var(--space-9);
  align-items: flex-start;
}
</style>
