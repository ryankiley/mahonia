<script setup lang="ts">
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, ogCardAlt, ogCardModel } from "~~/shared/ogCard";
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
// The card image: an edit link unfurls with the same per-list card as the share
// link, addressed by the share code this route already resolves through — the
// secret token in the fragment plays no part. Raw request origin is enough: only
// bare /e is prerendered, this nested route renders per request (see app.vue for
// the guard prerendering would need). Unresolved snapshot → undefined getters →
// unhead keeps the app-level static card.
const origin = useRequestURL().origin;
const card = computed(() => {
  if (!snap.value) return null;
  return {
    url: `${origin}/og/s/${snap.value.shareCode}`,
    alt: ogCardAlt(ogCardModel(snap.value.title, computeTotals(snap.value), snap.value.displayUnit)),
  };
});
useHead({
  title: () => (seo.value.name ? `${seo.value.name} — Mahonia` : "Mahonia"),
  // a capability link, not a page — keep it out of search (og still drives previews)
  meta: [{ name: "robots", content: "noindex" }],
});
useSeoMeta({
  description: () => seo.value.desc,
  ogTitle: () => seo.value.name || GENERIC_TITLE,
  ogDescription: () => seo.value.desc,
  ogImage: () => card.value?.url,
  ogImageAlt: () => card.value?.alt,
  ogImageWidth: () => (card.value ? OG_IMAGE_WIDTH : undefined),
  ogImageHeight: () => (card.value ? OG_IMAGE_HEIGHT : undefined),
  ogImageType: () => (card.value ? "image/png" : undefined),
  // app.vue sets a static twitterImage site-wide; override it like the read views do
  twitterImage: () => card.value?.url,
});
</script>

<template>
  <!-- GearEditor is a `.client` component (IndexedDB, the singleton controller,
       window refs), so Nuxt renders a placeholder on the server and mounts it on the
       client; the SSR pass above is purely the <head> for link-preview bots. -->
  <GearEditor />
</template>
