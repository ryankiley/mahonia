<script setup lang="ts">
import type { ChangelogEntry } from "~~/server/api/changelog.get";

// What's new, on a page of its own again.
//
// It lived as a section at the foot of /about for two months, on the reasoning that
// "what is this" and "what changed lately" are the same question asked by the same
// visitor, and that neither filled a page on its own. The second half stopped being
// true: About is six hundred words, and the log under it had grown to four hundred
// and fifty entries, ninety a month, so the page was nineteen parts changelog to one
// part about. About keeps the newest release and a link here; this page has all of it.
//
// Fetched, not imported. A module-scope `import` of content/changelog.json bundled
// every entry into this route's client chunk — content that only grows, on PRs that
// often ship no code. The server route does the read + the group flattening; this page
// is prerendered, so that runs at build time and the entries arrive in the payload.
const { data } = await useFetch<{ releases: ChangelogEntry[] }>("/api/changelog");
const releases = computed(() => data.value?.releases ?? []);

useHead({
  title: "What's new — Mahonia",
  meta: [
    {
      name: "description",
      content: "Everything that has shipped in Mahonia, newest first.",
    },
  ],
});

// "Last updated" is just the newest entry's date, formatted like the legal page's
// stamped line ("17 July 2026"), so it updates itself whenever an entry is added,
// with no commit hook to forget and no way to drift from the content.
const lastUpdated = computed(() => {
  const iso = releases.value[0]?.date;
  return iso ? formatCalendarDate(iso) : "";
});
</script>

<template>
  <div>
    <SiteTopbar label="What's new" />

    <main id="main-content" tabindex="-1" class="wrap page">
      <!-- the prose column, not .prose: the release list is a two-column spec sheet
           (date rail + entries), not running text, so it wants its own grid and its own
           gaps. It keeps the prose COLUMN though, same width, same edges. -->
      <div class="log">
        <header class="log__head">
          <h1 class="t-title">What's new</h1>
          <p class="t-sm t-muted">
            Mahonia is built in the open and changes often. Here’s what’s shipped, newest first.
            Each day is also a
            <a href="https://github.com/ryankiley/mahonia/releases" target="_blank" rel="noopener noreferrer"
              >release on GitHub</a
            >, with a feed.
          </p>
          <p v-if="lastUpdated" class="t-sm t-muted">Last updated {{ lastUpdated }}</p>
        </header>

        <ChangelogReleases :releases="releases" />
      </div>
    </main>
  </div>
</template>

<style scoped lang="scss">
.log {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  /* the same column as every other page of prose, both edges. Same token as .prose so
     the two cannot drift. */
  max-width: var(--prose);
  margin-inline: auto;
}
.log__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* running text without a measure is the fault /about was once fixed for; these two
   lines are the only prose on the page free to run the full column */
.log__head p {
  max-width: 64ch;
}
</style>
