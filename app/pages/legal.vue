<script setup lang="ts">
// CONTACT_EMAIL is auto-imported from app/utils/site.
// Privacy + Terms live together on one page (two sections, #privacy / #terms).
// /privacy and /terms redirect here (routeRules). The "Last updated" line is
// stamped at commit time by scripts/stamp-legal-dates.mjs.
useHead({
  title: "Legal — Mahonia",
  meta: [
    { name: "description", content: "Mahonia's privacy policy and terms of use, in plain language." },
  ],
});
</script>

<template>
  <div>
    <SiteTopbar>
      <span class="t-sm t-muted">Legal</span>
    </SiteTopbar>

    <main class="wrap page">
      <div class="prose">
        <h1 class="t-title">Legal</h1>
        <p class="t-sm t-muted">Last updated 17 July 2026</p>
        <p>
          How Mahonia handles your data, and the terms for using it — written to be read, not to trap
          you. Jump to <a href="#privacy">Privacy</a> or <a href="#terms">Terms</a>.
        </p>

        <!-- ================= Privacy ================= -->
        <h2 id="privacy" class="legal__break">Privacy</h2>
        <p>
          Mahonia is a tool for making and sharing packing lists, made by one person. There are no
          accounts, no advertising, and I don’t sell your data. This page describes what Mahonia stores,
          what it sends over the network and when, and where to ask questions. If anything here is
          unclear, email <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>.
        </p>

        <h3>Where your data lives</h3>
        <p>
          The lists you create (titles, folders, items, notes, and any weights) are saved on your
          device in your browser’s storage, and synced to the server as you build them. As soon as a
          list has real content (a first item, a first weight) it’s stored on the server under an
          unguessable private link. That sync is what lets the same edit link open your list on
          another device, and it’s why the editor says “Synced” from the start. An empty draft you
          never add anything to is never sent anywhere.
        </p>
        <p>
          A synced list is private by default: it isn’t listed anywhere on the site, search engines
          are asked not to index it, and only someone you give the link to can open it. Its contents
          stay on the server until you delete the list. Publishing is a separate, explicit step that
          puts a list in the public feed, and public means public: anyone can read it until you
          unpublish or delete it.
        </p>

        <h3>What Mahonia collects in the background</h3>
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
            views and performance. No advertising cookies, no cross-site tracking, no profile.
          </li>
        </ul>
        <p>
          Mahonia never asks for your name, email, password, payment details, or precise location.
        </p>

        <h3>The services Mahonia relies on</h3>
        <p>
          A few service providers run the plumbing on my behalf. They’re all US-based, so if you’re
          outside the US your data may be processed there.
        </p>
        <ul>
          <li><strong>Vercel</strong>: hosting, content delivery, and the aggregate analytics.</li>
          <li><strong>Neon</strong>: the database where your synced lists are stored.</li>
          <li><strong>Upstash</strong>: the store used for rate limiting.</li>
        </ul>

        <h3>Keeping and deleting your data</h3>
        <p>
          Because there are no accounts, you’re in control of removing things yourself:
        </p>
        <ul>
          <li>Open “Your lists” to see every list saved on this device.</li>
          <li>There, “Remove from device” takes a list off this browser (the list itself stays online for anyone with its link); “Delete” removes the list from the server for everyone.</li>
          <li>
            For anything else, including a copy or deletion of a shared list, email
            <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a> and I’ll sort it out.
          </li>
        </ul>
        <p>
          No system is perfectly secure, so please don’t put sensitive personal information into a
          list.
        </p>

        <h3>What Mahonia does not do</h3>
        <ul>
          <li>No accounts, no passwords, no advertising.</li>
          <li>No selling your data and no cross-site tracking.</li>
          <li>No advertising cookies, tracking pixels, or third-party trackers.</li>
        </ul>

        <h3>Children</h3>
        <p>
          Mahonia isn’t directed at children under 13 and doesn’t knowingly collect data from them. If
          you believe a child has provided data through Mahonia, email me and I’ll remove it.
        </p>

        <h3>Changes to this policy</h3>
        <p>
          Material changes to this policy will be reflected here with an updated date.
        </p>

        <!-- ================= Terms ================= -->
        <h2 id="terms" class="legal__break">Terms of Use</h2>
        <p>
          These terms cover your use of Mahonia. They’re written to be readable, not to trap you. Mahonia
          is made by one person, it’s free, and it has no accounts. By using it you agree to what’s
          below. If you don’t agree, that’s completely fine. Just don’t use it.
        </p>

        <h3>What Mahonia is</h3>
        <p>
          Mahonia is a free tool for making and sharing packing lists. A list’s private edit link is
          the only key to changing it; a separate read-only link lets others view it, and you can
          publish a list to a public feed.
        </p>

        <h3>The edit link is your responsibility</h3>
        <p>
          Anyone who has a list’s edit link can change that list. Keep it private and save it
          somewhere safe. If you lose it and haven’t saved it elsewhere, I can’t recover edit access
          for you.
        </p>

        <h3>Your content is yours</h3>
        <p>
          You keep ownership of the lists you create. By sharing or publishing one, you give me
          permission to store and display it so the feature works, and that permission ends when you
          remove the content. You’re responsible for what you put in your lists and for having the
          right to share it. Public means public: a published or shared list can be read by anyone
          with the link, so don’t share anything you wouldn’t want out in the open.
        </p>

        <h3>Fair use of Mahonia</h3>
        <p>
          Please don’t use Mahonia to break the law, infringe others’ rights, post abusive or deceptive
          content, impersonate people, or attack, overload, or scrape the service. Public lists can
          be flagged with the “Report list” action in the ⋯ menu; to report a problem or request a takedown, email
          <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a> with enough detail to find the
          content. I may remove content or limit access, including pulling lists off the public feed,
          especially in response to reports.
        </p>

        <h3>It’s free and provided “as is”</h3>
        <p>
          Mahonia is offered free of charge and may change, pause, or shut down at any time, and isn’t
          guaranteed to keep your data forever, so keep your own backups of anything important (the
          editor can export your list). It’s provided <strong>as is</strong> and
          <strong>as available</strong>, with no warranties of any kind, to the fullest extent the
          law allows. Weights, the catalog, and totals may be wrong or out of date, so don’t rely on
          Mahonia for anything safety-critical. Verify your own kit before you head out.
        </p>

        <h3>Limitation of liability</h3>
        <p>
          To the fullest extent permitted by law, I’m not liable for any indirect, incidental, or
          consequential damages, or for any loss of data, arising from your use of (or inability to
          use) Mahonia. As a free service, it comes with no guarantee of availability, accuracy, or
          fitness for any particular purpose.
        </p>

        <h3>Changes to these terms</h3>
        <p>
          These terms may change as Mahonia grows. Material changes will be reflected here with a new
          date. Continuing to use Mahonia after a change means you accept the updated terms.
        </p>

        <h3>Governing law</h3>
        <p>
          These terms are governed by the laws of the State of Oregon, United States, without regard
          to its conflict-of-laws rules. Nothing here limits any rights you have under the mandatory
          laws of the place you live.
        </p>

        <!-- ================= Contact ================= -->
        <h2 class="legal__break">Questions?</h2>
        <p>
          Anything about your privacy or these terms:
          <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>. See also
          <NuxtLink to="/about">About</NuxtLink>.
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page {
  padding-block: var(--space-5) var(--space-9);
}
/* The two major sections (Privacy / Terms) get a quiet top rule + extra air to
   mark the break — the site's headings are all one size, so the hierarchy comes
   from the rule and spacing, not a bigger font. */
.legal__break {
  margin-top: var(--space-7);
  padding-top: var(--space-5);
  border-top: 1px solid var(--line-2);
  scroll-margin-top: var(--space-5);
}
/* Subsection headings, demoted from h2 so the section titles are the parent
   level; matched to the site's single heading treatment (.prose h2). */
.prose h3 {
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: -0.02em;
  margin-top: var(--space-4);
}
</style>
