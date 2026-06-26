<script setup lang="ts">
import type { ListSnapshot, Unit } from "~~/shared/types";
import { computeTotals } from "~~/shared/weights";

const route = useRoute();
const code = String(route.params.code || "");

// SSR fetch so a shared link is readable before hydration + indexable structure.
const { data } = await useFetch<{ snapshot: ListSnapshot }>(`/api/s/${code}`);
const snapshot = ref<ListSnapshot | null>(data.value?.snapshot ?? null);

const unit = ref<Unit>(snapshot.value?.displayUnit ?? "g");
const totals = computed(() => (snapshot.value ? computeTotals(snapshot.value) : null));
// re-skin the snapshot with the viewer's chosen unit; the editor components read list.displayUnit
const roList = computed(() =>
  snapshot.value ? { ...snapshot.value, displayUnit: unit.value } : null,
);
const ungrouped = computed(() =>
  snapshot.value ? snapshot.value.items.filter((i) => !i.folderId) : [],
);
// a shared list shouldn't show empty folders
const shownFolders = computed(() =>
  roList.value
    ? roList.value.folders.filter((f) => snapshot.value!.items.some((i) => i.folderId === f.id))
    : [],
);

useHead({
  title: () => (snapshot.value ? `${snapshot.value.title} — Gear` : "Gear"),
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
    <header class="topbar">
      <div class="wrap topbar__inner">
        <NuxtLink to="/" class="t-label brand">Gear</NuxtLink>
        <span class="t-sm t-muted">Read-only</span>
        <NuxtLink to="/" class="btn btn--sm">Make your own</NuxtLink>
      </div>
    </header>

    <main v-if="roList && totals" class="wrap view">
      <h1 class="t-title view__title">{{ roList.title }}</h1>

      <TotalsBar :list="roList" :totals="totals" readonly @set-unit="(u) => (unit = u)" />

      <div class="view__folders">
        <FolderSection v-for="f in shownFolders" :key="f.id" :list="roList" :folder="f" readonly />
        <section v-if="ungrouped.length">
          <p class="t-label view__ungrouped">Ungrouped</p>
          <ItemRow v-for="it in ungrouped" :key="it.id" :list="roList" :item="it" readonly />
        </section>
      </div>
    </main>

    <main v-else class="wrap view view--missing">
      <p class="t-muted">This list doesn’t exist (or was removed).</p>
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
.topbar__inner .btn {
  margin-left: auto;
}
.view {
  padding-block: var(--space-5) var(--space-9);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.view__title {
  font-family: var(--font);
}
.view__folders {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}
.view__ungrouped {
  margin-bottom: var(--space-1);
}
.view--missing {
  padding-block: var(--space-9);
  align-items: flex-start;
}
</style>
