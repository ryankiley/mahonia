<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";
import { computeTotals } from "~~/shared/weights";

// The shareable edit link: /e/{shareCode}#{token}. The share code (a PUBLIC read
// capability) lets THIS route resolve the list's name SERVER-SIDE and put it in the
// <head>, so JS-less link-preview bots (Apple Notes / iMessage / Slack) show the
// list name instead of the generic site card. The secret edit token stays in the
// URL fragment (never sent to the server); the editor itself is client-only (it
// loads from that fragment, exactly like the bare /e route).
definePageMeta({ layout: false });

const route = useRoute();
const code = computed(() => String(route.params.code || ""));

// SSR fetch so the name is already in the initial HTML for a bot that doesn't run
// JS. Read-only + side-effect-free (no view bump); resolves for private lists too,
// since the share code is a capability. A bad/unknown code → data null → the
// generic card, and the editor still opens from the fragment token.
const { data } = await useFetch<{ snapshot: ListSnapshot }>(() => `/api/s/${code.value}`);
const snap = computed<ListSnapshot | null>(() => data.value?.snapshot ?? null);

// naming rule + description builder live in editorSeo (app/utils/editorSeo.ts), the
// single source shared with the editor's own client-side tab/share card.
const seo = computed(() => editorSeo(snap.value?.title, snap.value ? computeTotals(snap.value) : null));
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
</script>

<template>
  <!-- GearEditor is a `.client` component (IndexedDB, the singleton controller,
       window refs), so Nuxt renders a placeholder on the server and mounts it on the
       client; the SSR pass above is purely the <head> for link-preview bots. -->
  <GearEditor />
</template>
