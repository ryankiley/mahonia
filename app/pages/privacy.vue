<script setup lang="ts">
// CONTACT_EMAIL is auto-imported from app/utils/site.
useHead({
  title: "Privacy — Mahonia",
  meta: [{ name: "description", content: "What Mahonia stores, why, and how to remove it." }],
});
</script>

<template>
  <div>
    <SiteTopbar>
      <span class="t-sm t-muted">Privacy</span>
    </SiteTopbar>

    <main class="wrap page">
      <div class="prose">
        <h1 class="t-title">Privacy</h1>
        <p class="t-sm t-muted">Last updated 26 June 2026</p>

        <p>
          Mahonia is a tool for making and sharing packing lists, made by one person. There are no
          accounts, no advertising, and I don’t sell your data. This page describes what Mahonia stores,
          what it sends over the network and when, and where to ask questions. If anything here is
          unclear, email <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>.
        </p>

        <h2>Where your data lives</h2>
        <p>
          The lists you create — titles, folders, items, notes, and any weights — are saved on your
          device in your browser’s <code>localStorage</code>. While a list is just yours, it stays
          there and is never sent anywhere.
        </p>
        <p>
          A list is sent to the server only when you choose to share or publish it. At that point its
          contents are stored so the share link and public feed can work, and they stay stored until
          you unpublish or delete the list. Public means public: anyone with the link can read it.
        </p>

        <h2>What Mahonia collects in the background</h2>
        <p>
          Running the site touches a little technical data, kept to the minimum needed:
        </p>
        <ul>
          <li>
            <strong>Request data.</strong> Your IP address and basic request details are processed
            briefly to serve pages, apply rate limits, and stop abuse. The hosting provider keeps
            standard short-lived server logs.
          </li>
          <li>
            <strong>Aggregate analytics.</strong> Cookieless, privacy-preserving counts of page
            views and performance — no advertising cookies, no cross-site tracking, no profile.
          </li>
        </ul>
        <p>
          Mahonia never asks for your name, email, password, payment details, or precise location.
        </p>

        <h2>The services Mahonia relies on</h2>
        <p>
          A few service providers run the plumbing on my behalf. They’re all US-based, so if you’re
          outside the US your data may be processed there.
        </p>
        <ul>
          <li><strong>Vercel</strong> — hosting, content delivery, and the aggregate analytics.</li>
          <li><strong>Neon</strong> — the database that stores shared and public lists.</li>
          <li><strong>Upstash</strong> — the store used for rate limiting.</li>
        </ul>

        <h2>Keeping and deleting your data</h2>
        <p>
          Because there are no accounts, you’re in control of removing things yourself:
        </p>
        <ul>
          <li>Delete a list from this device in “Your lists,” or clear your browser storage.</li>
          <li>Unpublish or delete a shared or public list from its editor to remove it from the server.</li>
          <li>
            For anything else — including a copy or deletion of a shared list — email
            <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a> and I’ll sort it out.
          </li>
        </ul>
        <p>
          No system is perfectly secure, so please don’t put sensitive personal information into a
          list.
        </p>

        <h2>What Mahonia does not do</h2>
        <ul>
          <li>No accounts, no passwords, no advertising.</li>
          <li>No selling your data and no cross-site tracking.</li>
          <li>No advertising cookies, tracking pixels, or third-party trackers.</li>
        </ul>

        <h2>Children</h2>
        <p>
          Mahonia isn’t directed at children under 13 and doesn’t knowingly collect data from them. If
          you believe a child has provided data through Mahonia, email me and I’ll remove it.
        </p>

        <h2>Changes</h2>
        <p>
          Material changes to this policy will be reflected here with an updated date.
        </p>

        <h2>Contact</h2>
        <p>
          Questions or requests: <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>. See
          also the <NuxtLink to="/terms">Terms of Use</NuxtLink>.
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page {
  padding-block: var(--space-5) var(--space-9);
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}
</style>
