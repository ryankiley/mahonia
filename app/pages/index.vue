<script setup lang="ts">
// The bare address is "where you left off". With lists on this device, open the one
// opened most recently; with none, this page IS the fresh draft — the editor renders
// right here, and /e keeps meaning "new". Decided in a route middleware, in the
// browser, because the registry lives in localStorage — the server can't know — so
// the prerendered file and the SSR render are the same nothing for everyone.
//
// The editor is rendered here rather than reached through a redirect from an empty
// page, and that is a loading decision: a page that only navigates to /e has none of
// the editor's chunks in its preload hints, so a visitor typing the address fetched
// them one round trip AFTER the app shell had loaded (two, on a cold cache: the route
// file first, then what it imports). Rendering the editor puts its chunks beside the
// shell's in the HTML, downloaded in parallel — and a newcomer never leaves this URL
// to start a list.
import { resumeTarget } from "~~/shared/switcher";

definePageMeta({
  layout: false,
  middleware: [
    () => {
      if (import.meta.server) return;
      const target = resumeTarget(useMyLists().entries.value);
      if (!target) return; // nothing to go back to: this page is the draft
      // the editor aims its switcher hint at the list it was dropped into
      useResumed().value = target.shareCode;
      return navigateTo(target.to, { replace: true });
    },
  ],
});
// Prerendered as an empty shell that resolves on the client, so to a crawler it is a
// blank homepage: keep it out of the index. The indexable surface stays /about and
// /legal; the app itself lives behind unguessable links.
useHead({ meta: [{ name: "robots", content: "noindex" }] });
</script>

<template>
  <!-- A .client component (IndexedDB, the singleton controller, window refs): the
       server renders a placeholder, the browser mounts the draft. -->
  <GearEditor />
</template>
