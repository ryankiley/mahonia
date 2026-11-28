<script setup lang="ts">
import { READ_EDGE_CACHE_CONTROL } from "~/utils/site";
import type { ListSnapshot } from "~~/shared/types";

const route = useRoute();
const code = computed(() => String(route.params.code || ""));

// Fetched on the server, so a shared link is readable before hydration and has its
// structure in the HTML. Keyed by the code and derived, not copied once: an in-app
// /s/a → /s/b navigation refetches and the page tracks the answer. With no connection
// the answer is this device's copy of the list, or the reason there is none
// (useSharedList).
const { shared, loaded } = useSharedList(code);
await loaded;
const snapshot = computed<ListSnapshot | null>(() => shared.value?.snapshot ?? null);
const keptAt = computed(() => (shared.value?.snapshot ? shared.value.keptAt : undefined));
const missing = computed(() => (shared.value && !shared.value.snapshot ? shared.value.missing : undefined));

// edge-cache the HTML for a short window — collapses the burst when
// a share link makes the rounds; a read-only view tolerates 30 s of staleness.
useResponseHeader("Cache-Control").value = READ_EDGE_CACHE_CONTROL;

const { unit, fullTotals, personFilter, viewProps } = useReadonlyList(snapshot);

// Social unfurl (iMessage/Slack/etc.): the title + a short summary so a pasted share
// link shows the list name, not a bare URL (useReadonlyListSeo);
// this page's noindex (below) keeps it out of search — og tags still drive previews.
// fullTotals, not totals: the unfurl describes the list, not the viewer's filter.
useReadonlyListSeo(snapshot, fullTotals);
useHead({
  title: () => (snapshot.value ? `${snapshot.value.title} — Mahonia` : "Mahonia"),
  meta: [{ name: "robots", content: "noindex" }],
});
</script>

<template>
  <div>
    <!-- The top bar: the site bar, packed compact, carrying the one thing a reader is
         most likely to want (a list of their own) and the ⋯ of everything else. -->
    <SiteTopbar compact>
      <NuxtLink to="/e" class="btn btn--link">Create a list</NuxtLink>
      <!-- ⋯ goes in #end so it lands after the account glyph, matching the editor's
           bar (vault, account, share, ⋯). The reader's one text action keeps the
           lead; the two glyphs close the row. -->
      <template #end>
        <ReadonlyMenu v-if="snapshot" :snapshot="snapshot" />
      </template>
    </SiteTopbar>

    <!-- the view-model's props as one object (useReadonlyList.viewProps), so the page
         can't spell out a prop list that drifts from the view's own; beside it, the two
         things only the page knows: that the list is this device's copy, or why there
         is no list -->
    <ReadonlyListView
      v-bind="viewProps"
      :kept-at="keptAt"
      :missing="missing"
      @set-unit="(u) => (unit = u)"
      @pick-person="(id) => (personFilter = id)"
    />
  </div>
</template>
