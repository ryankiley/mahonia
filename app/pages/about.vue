<script setup lang="ts">
// CONTACT_EMAIL is auto-imported from app/utils/site.
//
// No changelog here. What's new lived at the foot of this page for two months, then
// briefly on a page of its own, and now it is GitHub's Releases: the same entries,
// one release per day that ships something, with a feed. The site says so once, in
// the Open source paragraph, and /changelog redirects there. The entries themselves
// are still written per PR (see shared/changelog.ts); only the rendering moved.
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
          >, so you can read how it works, file an issue, or run your own copy. Every day that
          ships something is a
          <a href="https://github.com/ryankiley/mahonia/releases" target="_blank" rel="noopener noreferrer"
            >release</a
          > there, with a feed.
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

    </main>
  </div>
</template>
