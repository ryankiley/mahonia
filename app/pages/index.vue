<script setup lang="ts">
// The bare address is "where you left off". With lists on this device, open the one
// opened most recently; with none, a fresh draft. /e always means "new". Decided in
// the browser because the registry lives in localStorage — the server can't know —
// and on mount rather than at setup, so the prerendered file and SSR render the same
// nothing. Crawlers get what the old redirect gave them (the editor is a client
// island either way); the indexable surface stays /about and /legal.
import { resumeTarget } from "~~/shared/switcher";

definePageMeta({ layout: false });
// Prerendered as an empty shell that resolves on the client (below), so to a crawler it
// is a blank homepage: keep it out of the index. The indexable surface stays /about
// and /legal; the app itself lives behind unguessable links.
useHead({ meta: [{ name: "robots", content: "noindex" }] });
const my = useMyLists();
const resumed = useResumed();
onMounted(() => {
  const target = resumeTarget(my.entries.value);
  resumed.value = target?.shareCode ?? null;
  navigateTo(target?.to ?? "/e", { replace: true });
});
</script>

<template>
  <div />
</template>
