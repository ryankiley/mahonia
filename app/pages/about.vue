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

// Dates print through formatCalendarDate (app/utils/time, auto-imported): parsed in
// LOCAL time from the parts, because `new Date("2026-06-27")` is UTC midnight and
// renders as the day before west of UTC — and in a FIXED locale, never `undefined`:
// the page is prerendered, so a runtime-locale format would differ between the build
// server and the visitor's browser and trip a hydration mismatch. Both rules live
// there (and shared/calendar.ts) rather than as this page's own copies.

// "Last updated" is just the newest entry's date, formatted like the legal
// page's stamped line ("17 July 2026") — so it updates itself whenever an entry
// is added, with no commit hook to forget and no way to drift from the content.
// computed, not a module-scope constant: `releases` is fetched, so this has to
// track it rather than read an empty array once at setup
const lastUpdated = computed(() => {
  const iso = releases.value[0]?.date;
  return iso ? formatCalendarDate(iso) : "";
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
          Mahonia is a tool for building, weighing, and sharing packing lists, made by one
          person. Make a list, see what it weighs, send someone the link. No app, no ads, and no
          sign-up to make a list — it's yours the moment you start typing. The grams are optional;
          build a list with zero weights and the totals just stay quiet.
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
          <li>
            A list remembers more than weights: calories on food and fuel, the unit you typed each
            row in, and the dates of the trip it's for.
          </li>
          <li>
            Flip the same list into a checklist for the night before, and tick things off as they
            go in the pack.
          </li>
          <li>
            <NuxtLink to="/gear">My Gear</NuxtLink> is the one part that asks for an
            account — a passkey, or a link emailed to you. It fills itself as you build, so the
            kit you already own is one pick away on the next list, from any device. Lists
            themselves never need it.
          </li>
        </ul>

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

        <h2>Open source</h2>
        <p>
          Mahonia is open source under the MIT license. The code lives on
          <a href="https://github.com/ryankiley/mahonia" target="_blank" rel="noopener noreferrer"
            >GitHub</a
          >, so you can read how it works, file an issue, or run your own copy.
        </p>

        <h2>Contact</h2>
        <p>
          Questions, or want a list removed? Email
          <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>. See also the
          <NuxtLink to="/legal">Legal</NuxtLink> page.
        </p>
      </div>

      <!-- ================= What's new ================= -->
      <!-- a sibling of .prose rather than a child: the release list is a two-column
           spec sheet (date rail + entries), not running text, so it wants its own grid
           and its own gaps. It keeps the prose COLUMN though — same width, same edges —
           see .log. -->
      <section id="whats-new" class="log">
        <header class="log__head">
          <h2 class="t-title">What's new</h2>
          <p class="t-sm t-muted">
            Mahonia is built in the open and changes often. Here’s what’s shipped, newest first.
          </p>
          <p v-if="lastUpdated" class="t-sm t-muted">Last updated {{ lastUpdated }}</p>
        </header>

        <section v-for="rel in releases" :key="rel.date" class="log__rel">
          <h3 class="log__date">
            <time :datetime="rel.date" class="t-title">{{ formatCalendarDate(rel.date) }}</time>
            <span v-if="rel.title" class="log__title t-sm t-muted">{{ rel.title }}</span>
          </h3>

          <div class="log__body">
            <div v-for="g in rel.groups" :key="g.label" class="log__group">
              <p class="log__label t-label">{{ g.label }}</p>
              <ul class="bullets">
                <li v-for="(item, i) in g.items" :key="i">{{ item }}</li>
              </ul>
            </div>
          </div>
        </section>
      </section>
    </main>
  </div>
</template>

<style scoped lang="scss">
.log {
  /* The section's own top rule + air, since .prose above it ends flush.
     --space-7, and NOT the --space-8 this asked for: there is no --space-8 in the scale
     (it runs 1-7 then 9), so the declaration was invalid at computed-value time and the
     margin resolved to 0 — the rule sat hard against the Contact paragraph with 24px of
     air below it and none above, the one lopsided hairline on the page. 48/24 is the
     same section break /legal already draws (.legal__break), which is what this was
     built to match. */
  margin-block-start: var(--space-7);
  padding-block-start: var(--space-5);
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  /* an anchor jump shouldn't tuck the heading under the sticky topbar */
  scroll-margin-top: var(--space-5);
  /* THE SAME COLUMN AS EVERYTHING ELSE ON THE PAGE — both edges, not just the left.
     This section used to sit outside .prose entirely, on the argument that a two-column
     spec sheet wants more width than a reading measure. What that actually bought was a
     page with three left edges going down it (headings at 62.5, "What's new" at 97, the
     date rail at 16) and a section whose rule ran to the page gutter while the copy
     above it stopped 46px short. Anchoring only the left edge fixed the first half and
     left the second: flush right, inset left, margins that plainly didn't match.
     A measure is not a squeeze here. The rail needs 12rem (the widest month-name date
     measures ~174px) and the entries take the remaining ~28rem, which is a longer line
     than the 60ch they used to ask for. Same token as .prose so the two cannot drift. */
  max-width: var(--prose);
  margin-inline: auto;
}
/* It wore `.prose` as well, which re-ran `margin-inline: auto` INSIDE .log — so
   "What's new" centred itself within the log's own box and landed 34.5px right of
   "Contact" directly above it. .log is already the column; this only needs its stack. */
.log__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* The measure came with `.prose` too, and running text without one is the fault this
   page was just fixed for — these two lines were the only prose on it free to run the
   full 42rem while every paragraph above them stopped at 64ch. */
.log__head p {
  max-width: 64ch;
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
/* the list, its marks, its ink and its measure are the shared `.bullets` (main.scss) —
   this is the same list the prose sections above it are, so it is now literally the
   same rule rather than a hand-copy that had drifted in size, position and measure */

@media (max-width: $bp-stack) {
  .log__rel {
    grid-template-columns: 1fr;
    gap: var(--space-3);
  }
}
</style>
