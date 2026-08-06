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
    <SiteTopbar label="Legal" />

    <main id="main-content" tabindex="-1" class="wrap page">
      <div class="prose">
        <h1 class="t-title">Legal</h1>
        <p class="t-sm t-muted">Last updated 6 August 2026</p>
        <p>
          How Mahonia handles your data, and the terms for using it. Jump to
          <a href="#privacy">Privacy</a> or <a href="#terms">Terms</a>.
        </p>

        <!-- ================= Privacy ================= -->
        <h2 id="privacy" class="legal__break">Privacy</h2>
        <p>
          Mahonia is made by one person. No advertising, and I don’t sell your data. Lists need no
          account; a gear vault does, and holds your email and nothing else. If
          anything here is unclear, email <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>.
        </p>

        <h3>Where your data lives</h3>
        <p>
          Your list titles, folders, items, notes and weights are saved in your browser, and synced
          to the server once a list has real content. An empty draft you never add anything to is
          never sent anywhere.
        </p>
        <p>
          A synced list is private: unlisted, not indexed, and openable only by someone you give the
          link to. Publishing is a separate, explicit step. Public means public: anyone can read it
          until you unpublish or delete it.
        </p>
        <p>
          <strong>Body weight</strong> is treated differently from everything else here, and more
          carefully. Planning a trip lets you enter it so the calorie estimates mean something; it
          is optional, and the rest of the planning view works without it. It is saved
          <strong>on this device only</strong> — it is never sent to the server, so it cannot
          appear on a share link, a published list, the public feed, or a JSON backup, and it does
          not follow you to another device. Clear the field and the estimates fall back to a stated
          assumption.
        </p>
        <p>
          Your <strong>gear vault</strong> is the one part that needs an account. It holds names,
          brands and weights, and belongs to you rather than to a browser — so signing in on another
          device brings it with you, and clearing this one doesn’t lose it. Gear reaches it when you
          add something to a list yourself, or import or copy a list. Opening a list someone shared
          with you doesn’t put their gear in your vault.
        </p>

        <h3>What Mahonia collects in the background</h3>
        <ul>
          <li>
            <strong>Request data.</strong> Your IP address and basic request details, processed
            briefly to serve pages, apply rate limits, and stop abuse. The host keeps standard
            short-lived logs.
          </li>
          <li>
            <strong>Analytics.</strong> Cookieless, aggregate counts of page views and performance.
            No advertising cookies, no cross-site tracking, no profile.
          </li>
        </ul>
        <p>
          An account holds an email address, an optional display name, and the public half of any
          passkey you add. There is no password to store, because there are no passwords — you sign
          in with a passkey or with a link sent to that address. Mahonia never asks for your real
          name, payment details, or location, and a display name is shown only if you set one. The
          one thing it asks about you — optionally, for trip planning — is your body weight, and
          that never leaves your device; see above.
        </p>

        <h3>What you type can improve the shared catalog</h3>
        <p>
          When you type a piece of gear that isn’t already in Mahonia’s catalog, the brand, name
          and weight are noted. If the same item is typed on <strong>three or more different
          lists</strong>, it’s added to the public catalog with the median weight, so everyone
          gets a suggestion instead of typing it again. Only branded products qualify — generic
          words like “tent” or “snacks” never make it in.
        </p>
        <p>
          Nothing that identifies you goes with it: not your list, not your account, not your
          email. What travels is the product and the weight, and the result is a catalog entry
          indistinguishable from any other.
        </p>

        <h3>The services Mahonia relies on</h3>
        <p>
          Four US-based providers run the plumbing, so your data may be processed there:
          <strong>Vercel</strong> (hosting, delivery, analytics), <strong>Neon</strong> (the
          database), <strong>Upstash</strong> (rate limiting, and the short-lived challenge a
          passkey needs), <strong>Resend</strong> (sending sign-in links — it therefore handles
          your email address).
        </p>

        <h3>Keeping and deleting your data</h3>
        <p>Removing things is mostly in your hands:</p>
        <ul>
          <li>
            “Your lists” shows every list saved on this device. “Remove from device” takes one off
            this browser (it stays online for anyone with the link); “Delete” removes it from the
            server for everyone.
          </li>
          <li>
            In your gear vault, “Remove” takes a piece of gear out and keeps it out. Signing out
            leaves the vault where it is, ready for the next time you sign in. “Sign out
            everywhere” ends every session on every device, if you ever need it.
          </li>
          <li>
            “Delete account” on your account page removes your email, display name, passkeys and
            your gear vault, straight away and without asking me. It asks separately whether to
            delete your lists; by default they stay, because they belong to their edit links rather
            than to your account.
          </li>
          <li>
            For anything else, including a copy or deletion of a shared list, email
            <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>.
          </li>
        </ul>
        <p>
          Some things are also cleaned up automatically, and the timings are exact rather than
          vague. A list that never got past a single item and hasn’t been edited for
          <strong>30 days</strong> is marked for removal; a gear vault untouched for
          <strong>180 days</strong> is treated the same way. Either is then held for
          <strong>90 days</strong> before it’s deleted for good, and using it again during that
          window brings it straight back — for a vault, signing in is enough. If you’ve lost
          something, email me and I’ll see what can be recovered.
        </p>
        <p>
          No system is perfectly secure. Please don’t put sensitive personal information into a
          list.
        </p>

        <h3>What Mahonia does not do</h3>
        <ul>
          <li>No passwords, no advertising. Lists need no account at all.</li>
          <li>No selling your data and no cross-site tracking.</li>
          <li>No advertising cookies, tracking pixels, or third-party trackers.</li>
        </ul>

        <h3>Children</h3>
        <p>
          Mahonia isn’t directed at children under 13 and doesn’t knowingly collect data from them.
          If you believe a child has provided data through Mahonia, email me and I’ll remove it.
        </p>

        <h3>Changes to this policy</h3>
        <p>Material changes will be reflected here with an updated date.</p>

        <!-- ================= Terms ================= -->
        <h2 id="terms" class="legal__break">Terms of Use</h2>
        <p>
          By using Mahonia you agree to what’s below. If you don’t agree, don’t use it.
        </p>

        <h3>What Mahonia is</h3>
        <p>
          A free tool for making and sharing packing lists. A list’s private edit link is the only
          key to changing it; a separate read-only link lets others view it; publishing puts it in a
          public feed.
        </p>

        <h3>The edit link is your responsibility</h3>
        <p>
          Anyone who has a list’s edit link can change that list. Keep it private and save it
          somewhere safe. If you lose it, I can’t recover edit access for you.
        </p>

        <h3>Your content is yours</h3>
        <p>
          You keep ownership of the lists you create. Sharing or publishing one gives me permission
          to store and display it so the feature works, and that permission ends when you remove the
          content. You’re responsible for what you put in your lists and for having the right to
          share it. Public means public, so don’t share anything you wouldn’t want out in the open.
        </p>

        <h3>Fair use of Mahonia</h3>
        <p>
          Please don’t use Mahonia to break the law, infringe others’ rights, post abusive or
          deceptive content, impersonate people, or attack, overload, or scrape the service. Public
          lists can be flagged with “Report list” in the ⋯ menu; to report a problem or request a
          takedown, email <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a> with enough
          detail to find the content. I may remove content or limit access, including pulling lists
          off the public feed.
        </p>

        <h3>It’s free and provided “as is”</h3>
        <p>
          Mahonia may change, pause, or shut down at any time, and isn’t guaranteed to keep your data
          forever. Keep your own backups of anything important; the editor can export your list.
          It’s provided <strong>as is</strong> and <strong>as available</strong>, with no warranties
          of any kind and no guarantee of availability, accuracy, or fitness for any particular
          purpose, to the fullest extent the law allows. Weights, the catalog, and totals may be
          wrong or out of date. Don’t rely on Mahonia for anything safety-critical, and verify your
          own kit before you head out.
        </p>

        <h3>Limitation of liability</h3>
        <p>
          To the fullest extent permitted by law, I’m not liable for any indirect, incidental, or
          consequential damages, or for any loss of data, arising from your use of (or inability to
          use) Mahonia.
        </p>

        <h3>Changes to these terms</h3>
        <p>
          These terms may change. Material changes will be reflected here with a new date, and
          continuing to use Mahonia after a change means you accept the updated terms.
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
  letter-spacing: var(--track-tight);
  margin-top: var(--space-4);
}
</style>
