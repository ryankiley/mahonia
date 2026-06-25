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

const UNITS: Unit[] = ["g", "kg", "oz", "lb"];
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
        <span class="t-micro t-faint">Read-only</span>
        <NuxtLink to="/" class="btn btn--sm">Make your own</NuxtLink>
      </div>
    </header>

    <main v-if="snapshot && totals" class="wrap view">
      <h1 class="t-h2 view__title">{{ snapshot.title }}</h1>

      <div class="totals panel">
        <div class="totals__main">
          <div class="totals__headline">
            <span class="t-label">{{ showBreakdown ? "Base weight" : "Total" }}</span>
            <span v-if="totals.hasWeights" class="t-num totals__big">
              {{ formatWeight(showBreakdown ? totals.baseMg : totals.totalMg, unit) }}
            </span>
            <span v-else class="t-faint">No weights on this list</span>
          </div>
          <div class="totals__controls">
            <div class="seg" role="group" aria-label="Display unit">
              <button v-for="u in UNITS" :key="u" :aria-pressed="unit === u" @click="unit = u">{{ u }}</button>
            </div>
            <button v-if="totals.hasWeights" class="btn btn--sm btn--ghost" @click="showBreakdown = !showBreakdown">
              {{ showBreakdown ? "Hide breakdown" : "Show breakdown" }}
            </button>
          </div>
        </div>
        <div v-if="showBreakdown && totals.hasWeights" class="totals__breakdown">
          <div class="totals__chips">
            <span class="chip"><span class="t-label">Base</span><span class="t-num">{{ formatWeight(totals.baseMg, unit) }}</span></span>
            <span class="chip"><span class="t-label">Worn</span><span class="t-num">{{ formatWeight(totals.wornMg, unit) }}</span></span>
            <span class="chip"><span class="t-label">Consum.</span><span class="t-num">{{ formatWeight(totals.consumableMg, unit) }}</span></span>
            <span class="chip"><span class="t-label">Total</span><span class="t-num">{{ formatWeight(totals.totalMg, unit) }}</span></span>
          </div>
          <CategoryBar :list="{ ...snapshot, displayUnit: unit }" />
        </div>
      </div>

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
            <span class="t-num t-micro t-muted">×{{ it.qty }}</span>
            <span class="t-num vrow__w">{{ it.unitWeightMg > 0 ? formatWeight(lineMg(it), unit) : "—" }}</span>
          </li>
          <li v-if="!itemsIn(f.id).length" class="t-small t-faint">—</li>
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
            <span class="t-num t-micro t-muted">×{{ it.qty }}</span>
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
.topbar { border-bottom: 1px solid var(--line-2); }
.topbar__inner { display: flex; align-items: center; gap: var(--space-3); padding-block: var(--space-3); }
.brand { letter-spacing: 0.1em; }
.topbar__inner .btn { margin-left: auto; }
.view { padding-block: var(--space-5) var(--space-9); display: flex; flex-direction: column; gap: var(--space-4); }
.view__title { font-family: var(--font-serif); }
.totals { padding: var(--space-4); }
.totals__main { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.totals__headline { display: flex; flex-direction: column; gap: var(--space-1); }
.totals__big { font-size: var(--t-h1); line-height: 1; color: var(--accent); }
.totals__controls { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.totals__breakdown { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: var(--space-3); }
.totals__chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.chip { display: inline-flex; align-items: baseline; gap: var(--space-2); padding: var(--space-1) var(--space-3); border: 1px solid var(--line); }
.folder { border: 1px solid var(--line-2); background: var(--paper-2); padding: var(--space-3) var(--space-4); }
.folder__head { display: flex; align-items: center; gap: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px solid var(--line); margin-bottom: var(--space-2); }
.folder__dot { width: 10px; height: 10px; flex: none; }
.folder__name { font-weight: 600; }
.rows { display: flex; flex-direction: column; }
.vrow { display: grid; grid-template-columns: 1fr 44px 96px; align-items: baseline; gap: var(--space-3); padding: var(--space-1) 0; }
.vrow__w { text-align: right; }
.vrow--worn .vrow__name::after { content: " · worn"; color: var(--cat-worn); font-size: var(--t-micro); }
.vrow--consumable .vrow__name::after { content: " · consumable"; color: var(--cat-consumable); font-size: var(--t-micro); }
.view--missing { padding-block: var(--space-9); align-items: flex-start; }
</style>
