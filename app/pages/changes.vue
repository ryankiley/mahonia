<script setup lang="ts">
import { formatWeight } from "~~/shared/weights";

interface RecentChange {
  id: number;
  itemName: string;
  oldWeightMg: number;
  newWeightMg: number;
  status: string;
  sourceUrl: string | null;
  createdAt: string;
}

const { data } = await useFetch<{ changes: RecentChange[] }>("/api/catalog/changes");
const changes = computed(() => data.value?.changes ?? []);

useHead({
  title: "Recent catalog changes — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

// Only treat http(s) citations as linkable — a javascript:/data: sourceUrl bound
// to :href would execute on click (Vue doesn't sanitize attribute bindings).
function safeUrl(u: string | null): URL | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
function host(u: string | null) {
  return safeUrl(u)?.hostname.replace(/^www\./, "") ?? "";
}
function safeHref(u: string | null) {
  return safeUrl(u)?.href;
}
function when(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
</script>

<template>
  <div>
    <SiteTopbar>
      <span class="t-sm t-muted">Catalog history</span>
    </SiteTopbar>

    <main class="wrap chg">
      <header class="chg__head">
        <h1 class="t-title">Recent catalog changes</h1>
        <p class="t-sm t-muted">
          Every weight edit is logged here. Uncited community values change instantly; verified
          weights only change with a trusted source — otherwise they’re proposed.
        </p>
      </header>

      <p v-if="!changes.length" class="t-muted">No changes yet.</p>

      <ul v-else class="chg__list">
        <li v-for="ch in changes" :key="ch.id" class="chg__row">
          <span class="chg__name">{{ ch.itemName }}</span>
          <span class="t-num t-sm chg__w">
            {{ formatWeight(ch.oldWeightMg, "g") }} → {{ formatWeight(ch.newWeightMg, "g") }}
          </span>
          <span class="t-sm chg__status" :class="`chg__status--${ch.status}`">{{ ch.status }}</span>
          <a
            v-if="host(ch.sourceUrl)"
            :href="safeHref(ch.sourceUrl)"
            class="t-sm chg__src"
            target="_blank"
            rel="noreferrer noopener"
            >{{ host(ch.sourceUrl) }}</a
          >
          <span v-else class="t-sm t-muted chg__src">—</span>
          <span class="t-sm t-muted chg__when">{{ when(ch.createdAt) }}</span>
        </li>
      </ul>
    </main>
  </div>
</template>

<style scoped>
.chg {
  padding-block: var(--space-5) var(--space-9);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.chg__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 42rem;
}
.chg__list {
  display: flex;
  flex-direction: column;
}
.chg__row {
  display: grid;
  grid-template-columns: 1fr auto 6.5rem 8rem 3rem;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--line);
}
.chg__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chg__w {
  color: var(--ink-2);
  white-space: nowrap;
}
.chg__status--applied {
  color: var(--accent);
}
.chg__status--proposed {
  color: var(--ink-2);
}
.chg__status--reverted,
.chg__status--rejected {
  color: var(--ink-3);
  text-decoration: line-through;
}
.chg__src {
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chg__when {
  text-align: right;
}

@media (max-width: 560px) {
  .chg__row {
    grid-template-columns: 1fr auto;
    gap: var(--space-1) var(--space-3);
  }
  .chg__status,
  .chg__src,
  .chg__when {
    grid-column: 1 / -1;
  }
}
</style>
