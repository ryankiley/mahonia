<script setup lang="ts">
import type { ChangelogEntry } from "~~/server/api/changelog.get";

// CONTACT_EMAIL is auto-imported from app/utils/site.
// About, with the NEWEST release of What's new at its foot and a link to the rest. The
// whole log lived here for two months (two sections, #about / #whats-new, the shape
// /legal takes for Privacy + Terms), and outgrew the page it was a section of: six
// hundred words of About over four hundred and fifty entries. /changelog is its own
// page again; this keeps one release, so "what is this" still ends with "and here is
// what changed this week". #whats-new stays on the section for the links that carry it.
//
// Fetched, not imported, and only ONE release: the payload this prerendered page
// carries is what a visitor downloads to read what Mahonia is, and the full log is
// fifty kilobytes of text they didn't come for.
const { data } = await useFetch<{ releases: ChangelogEntry[] }>("/api/changelog", {
  query: { limit: 1 },
});
const releases = computed(() => data.value?.releases ?? []);

useHead({
  title: "About — Mahonia",
  meta: [
    {
      name: "description",
      content: "What Mahonia is, why it's named after the Oregon grape, and how it works.",
    },
  ],
});

</script>

<template>
  <div>
    <SiteTopbar label="About" />

    <main id="main-content" tabindex="-1" class="wrap page">
      <div class="prose">
        <h1 class="t-title">About</h1>
        <p>What Mahonia is, and how it works.</p>

        <!-- ================= About ================= -->
        <h2 id="about">What it is</h2>
        <p>
          Mahonia is a tool for building, weighing, and sharing packing lists, made by one
          person. Make a list, see what it weighs, send someone the link. No app, no ads, and no
          sign-up to make a list: it's yours the moment you start typing. The grams are optional;
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
            sign-up. Nothing shows up publicly; a list is only ever reachable by its links.
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
            The Trip tab plans the walk itself. Add a trail as a link or a map file, break it into
            days, and each day shows its distance and climb, a walking-time estimate, and what the
            pack weighs when you shoulder it that morning, lighter as the food and water go. Name
            who's coming and mark who carries what.
          </li>
          <li>
            <NuxtLink to="/gear">My Gear</NuxtLink> is the one part that asks for an
            account: a passkey, or a link emailed to you. It fills itself as you build, so the
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

        <h2>From an assistant</h2>
        <p>
          Mahonia is also a connector. Add <code>https://mahonia.app/mcp</code> to an AI
          assistant that speaks MCP and it can read a list from its share link, search the
          catalog, make a new list, and, given an edit link, add to one. No sign-in: a share link
          is the permission to read and an edit link the permission to change, exactly as they
          are for a person.
        </p>
        <p>
          One click for
          <a
            href="https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Mahonia&connectorUrl=https%3A%2F%2Fmahonia.app%2Fmcp"
            target="_blank"
            rel="noopener noreferrer"
            >Claude</a
          >,
          <a
            href="https://cursor.com/install-mcp?name=mahonia&config=eyJ1cmwiOiJodHRwczovL21haG9uaWEuYXBwL21jcCJ9"
            target="_blank"
            rel="noopener noreferrer"
            >Cursor</a
          >
          or
          <a
            href="https://insiders.vscode.dev/redirect/mcp/install?name=mahonia&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmahonia.app%2Fmcp%22%7D"
            target="_blank"
            rel="noopener noreferrer"
            >VS Code</a
          >; the
          <a href="https://github.com/ryankiley/mahonia#mcp-connector" target="_blank" rel="noopener noreferrer"
            >README</a
          >
          has the line for every other client.
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
           see .log. Only the newest release; the page is /changelog. -->
      <section id="whats-new" class="log">
        <header class="log__head">
          <h2 class="t-title">What's new</h2>
          <p class="t-sm t-muted">
            Mahonia is built in the open and changes often. The latest is below; everything that
            has shipped is on <NuxtLink to="/changelog">What's new</NuxtLink>.
          </p>
        </header>

        <ChangelogReleases :releases="releases" />
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
</style>
