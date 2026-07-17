<script setup lang="ts">
import changelog from "~~/content/changelog.json";
import { sortReleases, type ChangelogRelease } from "~~/shared/changelog";

useHead({
  title: "What's new — Mahonia",
  meta: [
    {
      name: "description",
      content: "What's new in Mahonia — features and fixes as they ship, newest first.",
    },
  ],
});

const GROUP_DEFS = [
  { key: "added", label: "Added" },
  { key: "changed", label: "Changed" },
  { key: "fixed", label: "Fixed" },
] as const;

// Flatten once at module scope (the data is static, checked-in content): drop
// empty groups so the template just iterates what's there.
const releases = sortReleases(changelog as ChangelogRelease[]).map((rel) => ({
  date: rel.date,
  title: rel.title,
  groups: GROUP_DEFS.map((g) => ({ label: g.label, items: rel[g.key] ?? [] })).filter(
    (g) => g.items.length > 0,
  ),
}));

// Parse in LOCAL time from the parts — `new Date("2026-06-27")` parses as UTC
// midnight, which toLocaleDateString would render as the day before in a
// timezone west of UTC (like Portland).
function parseIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// Fixed locales, never `undefined`: the page is prerendered, so a runtime-locale
// format would differ between the build server and the visitor's browser and
// trip a hydration mismatch.
function fmtDate(iso: string) {
  return (
    parseIso(iso)?.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) ??
    iso
  );
}

// "Last updated" is just the newest entry's date, formatted like the legal
// pages' stamped line ("17 July 2026") — so it updates itself whenever an entry
// is added, with no commit hook to forget and no way to drift from the content.
const lastUpdated = (() => {
  const iso = releases[0]?.date;
  if (!iso) return "";
  return (
    parseIso(iso)?.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) ??
    iso
  );
})();
</script>

<template>
  <div>
    <SiteTopbar>
      <span class="t-sm t-muted">What's new</span>
    </SiteTopbar>

    <main class="wrap page log">
      <header class="log__head">
        <h1 class="t-title">What's new</h1>
        <p class="t-sm t-muted">
          Mahonia is built in the open and changes often. Here’s what’s shipped, newest first.
        </p>
        <p v-if="lastUpdated" class="t-sm t-muted">Last updated {{ lastUpdated }}</p>
      </header>

      <section v-for="rel in releases" :key="rel.date" class="log__rel">
        <h2 class="log__date">
          <time :datetime="rel.date" class="t-title">{{ fmtDate(rel.date) }}</time>
          <span v-if="rel.title" class="log__title t-sm t-muted">{{ rel.title }}</span>
        </h2>

        <div class="log__body">
          <div v-for="g in rel.groups" :key="g.label" class="log__group">
            <p class="log__label t-label">{{ g.label }}</p>
            <ul class="log__items">
              <li v-for="(item, i) in g.items" :key="i" class="log__item">{{ item }}</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.log {
  padding-block: var(--space-5) var(--space-9);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.log__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 42rem;
}

/* date rail on the left, entries on the right — spec-sheet rhythm */
.log__rel {
  display: grid;
  grid-template-columns: 12rem 1fr;
  gap: var(--space-5);
  padding-top: var(--space-5);
  border-top: 1px solid var(--line);
}
.log__date {
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
}
.log__title {
  font-weight: 400;
}

.log__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.log__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.log__label {
  color: var(--ink-2);
}
.log__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
  max-width: 60ch;
}
.log__item {
  position: relative;
  padding-left: var(--space-4);
  color: var(--ink-2);
}
/* the same quiet drawn bullet the .prose lists use */
.log__item::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.62em;
  width: 0.34em;
  height: 0.34em;
  border-radius: 50%;
  background: var(--ink-3);
}

@media (max-width: 720px) {
  .log__rel {
    grid-template-columns: 1fr;
    gap: var(--space-3);
  }
}
</style>
