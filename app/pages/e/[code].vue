<script setup lang="ts">
import type { ListSnapshot } from "~~/shared/types";
import { computeTotals, formatWeightAuto } from "~~/shared/weights";

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

const GENERIC_TITLE = "Mahonia — pack lists, weighed";
const GENERIC_DESC = "Make a packing list, see what it weighs, share it. No login.";
// mirror the editor's rule: the default "Untitled list" (or empty) is "not named",
// so an unnamed list keeps the generic card rather than advertising "Untitled list".
const name = computed(() => {
  const t = snap.value?.title?.trim();
  return t && t !== "Untitled list" ? t : "";
});
const desc = computed(() => {
  if (!name.value) return GENERIC_DESC;
  const t = snap.value ? computeTotals(snap.value) : null;
  if (!t) return `${name.value}, a packing list on Mahonia.`;
  const bits = [`${t.itemCount} items`];
  if (t.hasWeights) bits.push(`${formatWeightAuto(t.baseMg)} base weight`);
  return `${name.value}, a packing list (${bits.join(" · ")}) on Mahonia.`;
});
useHead({
  title: () => (name.value ? `${name.value} — Mahonia` : "Mahonia"),
  // a capability link, not a page — keep it out of search (og still drives previews)
  meta: [{ name: "robots", content: "noindex" }],
});
useSeoMeta({
  description: () => desc.value,
  ogTitle: () => name.value || GENERIC_TITLE,
  ogDescription: () => desc.value,
});
</script>

<template>
  <!-- GearEditor is a `.client` component (IndexedDB, the singleton controller,
       window refs), so Nuxt renders a placeholder on the server and mounts it on the
       client; the SSR pass above is purely the <head> for link-preview bots. -->
  <GearEditor />
</template>
