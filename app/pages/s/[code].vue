<script setup lang="ts">
import type { ListSnapshot, Unit } from "~~/shared/types";
import { computeTotals, effectiveClassification, formatWeight, lineMg } from "~~/shared/weights";

const route = useRoute();
const code = String(route.params.code || "");

// SSR fetch so a shared link is readable before hydration + indexable structure.
const { data, error } = await useFetch<{ snapshot: ListSnapshot }>(`/api/s/${code}`);
const snapshot = ref<ListSnapshot | null>(data.value?.snapshot ?? null);

const unit = ref<Unit>(snapshot.value?.displayUnit ?? "g");
const showBreakdown = ref(false);
const totals = computed(() => (snapshot.value ? computeTotals(snapshot.value) : null));

const itemsIn = (fid: string) =>
  (snapshot.value?.items ?? [])
    .filter((i) => i.folderId === fid)
    .sort((a, b) => a.sortOrder - b.sortOrder);

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
        <NuxtLink to="/" class="t-label brand">GEAR</NuxtLink>
        <span class="t-xs t-faint">Read-only</span>
        <NuxtLink to="/" class="btn btn--sm">Make your own</NuxtLink>
      </div>
    </header>

    <main v-if="snapshot && totals" class="wrap view">
      <h1 class="t-title view__title">{{ snapshot.title }}</h1>

      <TotalsBar
        :list="{ ...snapshot, displayUnit: unit }"
        :totals="totals"
        v-model:show-breakdown="showBreakdown"
        readonly
        @set-unit="(u) => (unit = u)"
      />

      <section v-for="f in snapshot.folders" :key="f.id" class="folder">
        <header class="folder__head">
          <span class="folder__dot" :style="{ background: `var(--cat-${f.colorKey ?? 'other'})` }" />
          <span class="folder__name">{{ f.name }}</span>
        </header>
        <ul class="rows">
          <li v-for="it in itemsIn(f.id)" :key="it.id" class="vrow" :class="`vrow--${effectiveClassification(it, snapshot.folders)}`">
            <span class="vrow__name">
              <template v-if="it.brand">{{ it.brand }} </template>{{ it.name }}
            </span>
            <span class="t-num t-xs t-muted">×{{ it.qty }}</span>
            <span class="t-num vrow__w">{{ it.unitWeightMg > 0 ? formatWeight(lineMg(it), unit) : "—" }}</span>
          </li>
          <li v-if="!itemsIn(f.id).length" class="t-sm t-faint">—</li>
        </ul>
      </section>

      <section v-if="snapshot.items.some((i) => !i.folderId)" class="folder">
        <header class="folder__head"><span class="folder__name">Ungrouped</span></header>
        <ul class="rows">
          <li
            v-for="it in snapshot.items.filter((i) => !i.folderId)"
            :key="it.id"
            class="vrow"
            :class="`vrow--${effectiveClassification(it, snapshot.folders)}`"
          >
            <span class="vrow__name"><template v-if="it.brand">{{ it.brand }} </template>{{ it.name }}</span>
            <span class="t-num t-xs t-muted">×{{ it.qty }}</span>
            <span class="t-num vrow__w">{{ it.unitWeightMg > 0 ? formatWeight(lineMg(it), unit) : "—" }}</span>
          </li>
        </ul>
      </section>
    </main>

    <main v-else class="wrap view view--missing">
      <p class="t-muted">This list doesn’t exist (or was removed).</p>
      <NuxtLink to="/" class="btn btn--primary">Make a list</NuxtLink>
    </main>
  </div>
</template>

<style scoped>
.topbar { border-bottom: 1px solid var(--line); }
.topbar__inner { display: flex; align-items: center; gap: var(--space-3); padding-block: var(--space-3); }
.brand { letter-spacing: 0.1em; }
.topbar__inner .btn { margin-left: auto; }
.view { padding-block: var(--space-5) var(--space-9); display: flex; flex-direction: column; gap: var(--space-6); }
.view__title { font-family: var(--font-serif); }
.folder { padding: 0; }
.folder__head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
.folder__dot { width: 8px; height: 8px; flex: none; }
.folder__name { font-weight: 700; font-size: var(--text-title); letter-spacing: -0.01em; }
.rows { display: flex; flex-direction: column; }
.vrow { display: grid; grid-template-columns: 1fr 44px 96px; align-items: baseline; gap: var(--space-3); padding: var(--space-1) 0; }
.vrow__w { text-align: right; }
.vrow--worn .vrow__name::after { content: " · worn"; color: var(--cat-worn); font-size: var(--text-xs); }
.vrow--consumable .vrow__name::after { content: " · consumable"; color: var(--cat-consumable); font-size: var(--text-xs); }
.view--missing { padding-block: var(--space-9); align-items: flex-start; }
</style>
