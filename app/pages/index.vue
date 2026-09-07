<script setup lang="ts">
// The bare address: resume the list you opened last, or be the fresh draft. The
// decision is app/middleware/resume.ts — a named middleware, so the routes table
// needn't import this page to know about it — and it runs before this page renders.
//
// The editor is rendered here rather than reached through a redirect from an empty
// page, and that is a loading decision: a page that only navigates to /e has none of
// the editor's chunks in its preload hints, so a visitor typing the address fetched
// them one round trip AFTER the app shell had loaded (two, on a cold cache: the route
// file first, then what it imports). Rendering the editor puts its chunks beside the
// shell's in the HTML, downloaded in parallel — and a newcomer never leaves this URL
// to start a list.
import { resumeTarget } from "~~/shared/switcher";

definePageMeta({ layout: false, middleware: "resume" });

// This page can still mount with a list to resume, and must then mount NOTHING. A
// prerendered page is hydrated against the address it was rendered for and only then
// moved to the address actually opened, so `/?utm_source=…` (a shared link with a
// query, or a hash) hydrates as `/`, is redirected by the middleware, and after the
// first paint is set back to the full address — directly, with no middleware in the
// way — before the middleware redirects it once more. That intermediate mount is the
// one place this page renders while a resume is pending; an editor mounted there
// would start a throwaway draft, tearing the resumed list down and writing an empty
// draft over the on-device slot on its way out. A bare div matches what the server
// rendered for the editor's client-only placeholder, so nothing is disturbed.
const resuming = import.meta.client && !!resumeTarget(useMyLists().entries.value);

// Prerendered as an empty shell that resolves on the client, so to a crawler it is a
// blank homepage: keep it out of the index. The indexable surface stays /about and
// /legal; the app itself lives behind unguessable links.
useHead({ meta: [{ name: "robots", content: "noindex" }] });
</script>

<template>
  <div v-if="resuming" />
  <!-- A .client component (IndexedDB, the singleton controller, window refs): the
       server renders a placeholder, the browser mounts the draft. -->
  <GearEditor v-else />
</template>
