<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";
import { computeTotals } from "~~/shared/weights";
import { normalizeShareCode } from "~~/shared/links";

// The shareable edit link: /e/{shareCode}#{token}. The share code (a PUBLIC read
// capability) lets THIS route resolve the list's name SERVER-SIDE and put it in the
// <head>, so JS-less link-preview bots (Apple Notes / iMessage / Slack) show the
// list name instead of the generic site card. The secret edit token stays in the
// URL fragment (never sent to the server); the editor itself is client-only (it
// loads from that fragment, exactly like the bare /e route).
// One key for every /e/{code}: a switch from one list to another reuses this page and
// the editor in it, so the bar and the weight figure stay put and the figure counts
// from the old list's total to the new one's (GearEditor's route watcher swaps the
// session; only the parts that hold one list's state remount).
definePageMeta({ layout: false, key: "e-code" });

const route = useRoute();
const code = computed(() => String(route.params.code || ""));

// SSR fetch so the name is already in the initial HTML for a bot that doesn't run
// JS. Read-only + side-effect-free (no view bump); resolves for private lists too,
// since the share code is a capability. A bad/unknown code → data null → the
// generic card, and the editor still opens from the fragment token.
//
// SERVER ONLY. On a hydrating page the data arrives in the payload; on an in-app
// navigation here — the switcher, the bare address resuming a list — nobody reads
// this head: the editor mounts, loads the list itself and titles the tab from it.
// The default would have fetched anyway, and because this setup awaits it, held the
// editor's mount until /api/s answered — a round trip, and a function invocation,
// spent on a title that is overwritten as soon as it lands. `watch: false` for the
// same reason: the editor titles the tab itself once a list is open.
const { data } = await useFetch<{ snapshot: ListSnapshot }>(() => `/api/s/${code.value}`, {
  immediate: import.meta.server,
  watch: false,
});
// The page outlives a change of code now (the key above), so the server's answer is
// only this list's while its code is still the one in the address.
const snap = computed<ListSnapshot | null>(() => {
  const s = data.value?.snapshot;
  return s && s.shareCode === normalizeShareCode(code.value) ? s : null;
});

// naming rule + description builder live in editorSeo (app/utils/editorSeo.ts), the
// single source shared with the editor's own client-side tab/share card.
const totals = computed(() => (snap.value ? computeTotals(snap.value) : null));
const seo = computed(() => editorSeo(snap.value?.title, totals.value, snap.value?.displayUnit));
// The card image: an edit link unfurls with the same per-list card as the share
// link, addressed by the share code this route already resolves through — the
// secret token in the fragment plays no part.
useListOgCard(() =>
  snap.value && totals.value
    ? { path: `/og/s/${snap.value.shareCode}`, list: snap.value, totals: totals.value }
    : null,
);
useHead({
  title: () => (seo.value.name ? `${seo.value.name} — Mahonia` : "Mahonia"),
  // a capability link, not a page — keep it out of search (og still drives previews)
  meta: [{ name: "robots", content: "noindex" }],
});
useSeoMeta({
  description: () => seo.value.desc,
  ogTitle: () => seo.value.name || GENERIC_TITLE,
  ogDescription: () => seo.value.desc,
});

// Keep the list you're leaving on screen until this one can paint — see readAhead. Not
// while the page hydrates: there is nothing on screen to keep, and holding hydration for
// the read only made the top bar arrive later. The editor mounts with its bar whole
// (status "loading" keeps the controls up, at a height of its own) and the list lands
// under it a read later.
if (import.meta.client && !useNuxtApp().isHydrating) await readAhead(route);
</script>

<template>
  <!-- GearEditor is a `.client` component (IndexedDB, the singleton controller,
       window refs), so Nuxt renders a placeholder on the server and mounts it on the
       client; the SSR pass above is purely the <head> for link-preview bots. -->
  <GearEditor />
</template>
