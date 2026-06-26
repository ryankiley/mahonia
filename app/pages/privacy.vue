<script setup lang="ts">
useHead({
  title: "Privacy — Gear",
  meta: [{ name: "description", content: "What Gear stores, why, and how to remove it." }],
});
</script>

<template>
  <div>
    <header class="topbar">
      <div class="wrap topbar__inner">
        <NuxtLink to="/" class="t-label brand">Gear</NuxtLink>
        <span class="t-sm t-muted">Privacy</span>
      </div>
    </header>

    <main class="wrap page">
      <div class="prose">
        <h1 class="t-title">Privacy Policy</h1>
        <p class="t-sm t-muted">Last updated 25 June 2026</p>

        <p>
          This policy explains what Gear collects, why, and what you can do about it. It’s written
          to be read, not just filed. If anything here is unclear, email
          <a href="mailto:ryanekiley@gmail.com">ryanekiley@gmail.com</a>.
        </p>

        <h2>The short version</h2>
        <ul>
          <li>No accounts, no login, no advertising, no selling your data.</li>
          <li>Your lists stay in your browser until you choose to share or publish them.</li>
          <li>We keep the minimum needed to make the service work and to stop abuse.</li>
          <li>You can remove your data yourself, or ask us to.</li>
        </ul>

        <h2>Who is responsible for your data</h2>
        <p>
          Gear is run by an individual operator based in Oregon, USA, who is the “data controller”
          for the purposes of this policy. Contact:
          <a href="mailto:ryanekiley@gmail.com">ryanekiley@gmail.com</a>.
        </p>

        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>Lists you create</strong> — titles, folders, items, notes, and any weights.
            While you’re editing, this is saved only in your browser’s <code>localStorage</code> on
            your device. It’s sent to our server only when you create a shareable or public list.
          </li>
          <li>
            <strong>Technical data</strong> — your IP address and basic request details, processed
            briefly to operate the site, apply rate limits, and prevent abuse. Our hosting provider
            keeps standard server logs.
          </li>
          <li>
            <strong>Aggregate usage</strong> — privacy-preserving analytics about page views and
            performance, with no advertising cookies and no cross-site tracking.
          </li>
        </ul>
        <p>
          We do <strong>not</strong> ask for or collect your name, email, password, payment details,
          or precise location.
        </p>

        <h2>Why we use it, and our legal basis</h2>
        <p>
          We use the data above only to: provide and maintain the service; make shared and public
          lists work; keep the service secure and prevent abuse; and understand aggregate usage so
          we can improve it. Where the GDPR applies, our legal basis is our legitimate interest in
          running a reliable, abuse-resistant service, and performing the service you ask for when
          you share or publish a list. We don’t use your data for advertising or profiling.
        </p>

        <h2>Cookies and local storage</h2>
        <p>
          Gear doesn’t use advertising or cross-site tracking cookies. The only data kept on your
          device is functional storage the app needs to work — primarily your lists in
          <code>localStorage</code>. You can clear it any time through your browser.
        </p>

        <h2>Who we share data with</h2>
        <p>
          We don’t sell your data or share it for advertising. We use a small number of service
          providers that process data on our behalf to run the site:
        </p>
        <ul>
          <li><strong>Vercel</strong> — hosting, content delivery, and aggregate analytics.</li>
          <li><strong>Neon</strong> — the database that stores shared and public lists.</li>
          <li><strong>Upstash</strong> — the store used for rate limiting.</li>
        </ul>
        <p>
          These providers operate in the United States, so if you’re outside the US your data may be
          processed there. We may also disclose data if required by law, or to protect the rights,
          safety, and security of Gear and its users.
        </p>

        <h2>How long we keep it</h2>
        <ul>
          <li>Lists in your browser stay until you delete them or clear your browser.</li>
          <li>
            Shared and public lists stay on our server until you unpublish or delete them, or ask
            us to remove them.
          </li>
          <li>Server logs and rate-limit data are short-lived and rotate automatically.</li>
        </ul>

        <h2>Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, delete, or
          receive a copy of your data, and to object to or restrict certain processing. Because Gear
          has no accounts, the fastest way to exercise most of these is directly:
        </p>
        <ul>
          <li>Delete a list from this device in “Your lists.”</li>
          <li>Unpublish or stop sharing a list from its editor to remove it from our server.</li>
          <li>
            For anything else — including access, deletion, or a copy of a shared list — email
            <a href="mailto:ryanekiley@gmail.com">ryanekiley@gmail.com</a> and we’ll respond within
            a reasonable time.
          </li>
        </ul>
        <p>
          If you’re in California, note that we do not sell or “share” personal information as those
          terms are used under California law. If you’re in the EU or UK, you also have the right to
          complain to your local data protection authority.
        </p>

        <h2>Children</h2>
        <p>
          Gear isn’t directed at children under 13, and we don’t knowingly collect data from them.
          If you believe a child has provided data through Gear, contact us and we’ll remove it.
        </p>

        <h2>Security</h2>
        <p>
          We take reasonable measures to protect data, but no method of transmission or storage is
          perfectly secure, and we can’t guarantee absolute security. Don’t put sensitive personal
          information into a list.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          We may update this policy from time to time. We’ll change the “last updated” date above,
          and significant changes will be reflected here. Continuing to use Gear after a change
          means you accept the updated policy.
        </p>

        <h2>Contact</h2>
        <p>
          Questions or requests: <a href="mailto:ryanekiley@gmail.com">ryanekiley@gmail.com</a>. See
          also our <NuxtLink to="/terms">Terms of Use</NuxtLink>.
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.topbar {
  border-bottom: 1px solid var(--line);
}
.topbar__inner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-block: var(--space-3);
}
.brand {
  color: var(--ink);
}
.page {
  padding-block: var(--space-5) var(--space-9);
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}
</style>
