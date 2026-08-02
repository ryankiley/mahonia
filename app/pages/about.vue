<script setup lang="ts">
import type { ChangelogEntry } from "~~/server/api/changelog.get";

// CONTACT_EMAIL is auto-imported from app/utils/site.
// About + What's new live together on one page (two sections, #about / #whats-new),
// the same shape /legal takes for Privacy + Terms. /changelog redirects here
// (routeRules). They belong together: "what is this" and "what changed lately" are
// the same question asked by the same visitor, and neither filled a page on its own.
//
// Fetched, not imported. A module-scope `import` of content/changelog.json bundled
// every entry into this route's client chunk — content that only grows, on PRs that
// often ship no code. The server route does the read + the group flattening; this page
// is prerendered, so that runs at build time and the entries arrive in the payload.
const { data } = await useFetch<{ releases: ChangelogEntry[] }>("/api/changelog");
const releases = computed(() => data.value?.releases ?? []);

useHead({
  title: "About — Mahonia",
  meta: [
    {
      name: "description",
      content: "What Mahonia is, why it's named after the Oregon grape, and what's shipped lately.",
    },
  ],
});

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
// page's stamped line ("17 July 2026") — so it updates itself whenever an entry
// is added, with no commit hook to forget and no way to drift from the content.
// computed, not a module-scope constant: `releases` is fetched, so this has to
// track it rather than read an empty array once at setup
const lastUpdated = computed(() => {
  const iso = releases.value[0]?.date;
  if (!iso) return "";
  return (
    parseIso(iso)?.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) ??
    iso
  );
});
</script>

<template>
  <div>
    <SiteTopbar label="About" />

    <main id="main-content" tabindex="-1" class="wrap page">
      <div class="prose">
        <h1 class="t-title">About</h1>
        <p>
          What Mahonia is, and what's changed lately. Jump to
          <a href="#whats-new">What's new</a>.
        </p>

        <!-- ================= About ================= -->
        <h2 id="about">What it is</h2>
        <p>
          Mahonia is a no-login tool for building, weighing, and sharing packing lists, made by one
          person. Make a list, see what it weighs, send someone the link. No account, no app, no
          ads. The grams are optional; build a list with zero weights and the totals just stay
          quiet.
        </p>

        <h2>Why “Mahonia”?</h2>
        <p>
          <em>Mahonia</em> is the Oregon grape, the Oregon state flower and one of the most common
          native plants in the Pacific Northwest woods this tool is built for. It’s an unfussy
          evergreen shrub: holly-shaped leaves, bright yellow flowers in late winter, dusty-blue
          berries. Hardy, understated, and everywhere on the trails around Portland.
        </p>
        <p>
          I wanted a name that was short, a little bit odd, and actually rooted in the place this
          tool is built for. A native plant, for a tool about getting outside, felt right.
        </p>

        <h2>The short version of how it works</h2>
        <ul>
          <li>
            A list syncs to the server under a private, unguessable link as soon as you start
            building it. That’s how the same list opens on your phone and your laptop.
          </li>
          <li>
            Every list gets a private edit link and a separate read-only link to share. No
            sign-up. Nothing shows up publicly unless you choose to publish it.
          </li>
          <li>Weights are backed by a curated, cited gear catalog, but you can override anything.</li>
        </ul>

        <h2>Open source</h2>
        <p>
          Mahonia is open source under the MIT license. The code lives on
          <a href="https://github.com/ryankiley/mahonia" target="_blank" rel="noopener noreferrer"
            >GitHub</a
          >, so you can read how it works, file an issue, or run your own copy.
        </p>

        <p>
          Questions, or want a list removed? Email
          <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>. See also the
          <NuxtLink to="/legal">Legal</NuxtLink> page.
        </p>
      </div>

      <!-- ================= What's new ================= -->
      <!-- outside .prose: the release list is a two-column spec sheet (date rail +
           entries), not running text, and the prose measure would squeeze it -->
      <section id="whats-new" class="log">
        <header class="log__head prose">
          <h2 class="t-title">What's new</h2>
          <p class="t-sm t-muted">
            Mahonia is built in the open and changes often. Here’s what’s shipped, newest first.
          </p>
          <p v-if="lastUpdated" class="t-sm t-muted">Last updated {{ lastUpdated }}</p>
        </header>

        <section v-for="rel in releases" :key="rel.date" class="log__rel">
          <h3 class="log__date">
            <time :datetime="rel.date" class="t-title">{{ fmtDate(rel.date) }}</time>
            <span v-if="rel.title" class="log__title t-sm t-muted">{{ rel.title }}</span>
          </h3>

          <div class="log__body">
            <div v-for="g in rel.groups" :key="g.label" class="log__group">
              <p class="log__label t-label">{{ g.label }}</p>
              <ul class="log__items">
                <li v-for="(item, i) in g.items" :key="i" class="log__item">{{ item }}</li>
              </ul>
            </div>
          </div>
        </section>
      </section>
    </main>
  </div>
</template>

<style scoped lang="scss">
.page {
  padding-block: var(--space-5) var(--space-9);
}
.log {
  /* the section's own top rule + air, since .prose above it ends flush */
  margin-block-start: var(--space-8);
  padding-block-start: var(--space-5);
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  /* an anchor jump shouldn't tuck the heading under the sticky topbar */
  scroll-margin-top: var(--space-5);
}
/* .prose already gives the column + 42rem measure; only the tighter gap is ours */
.log__head {
  gap: var(--space-2);
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

@media (max-width: $bp-stack) {
  .log__rel {
    grid-template-columns: 1fr;
    gap: var(--space-3);
  }
}
</style>
