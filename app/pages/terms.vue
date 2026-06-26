<script setup lang="ts">
useHead({
  title: "Terms — Gear",
  meta: [{ name: "description", content: "The terms for using Gear." }],
});
</script>

<template>
  <div>
    <header class="topbar">
      <div class="wrap topbar__inner">
        <NuxtLink to="/" class="t-label brand">Gear</NuxtLink>
        <span class="t-sm t-muted">Terms</span>
      </div>
    </header>

    <main class="wrap page">
      <div class="prose">
        <h1 class="t-title">Terms of Use</h1>
        <p class="t-sm t-muted">Last updated 25 June 2026</p>

        <p>
          These terms are the agreement between you and Gear. By using the site, you accept them.
          They’re written plainly on purpose. If you don’t agree, please don’t use Gear.
        </p>

        <h2>Who can use Gear</h2>
        <p>
          You may use Gear if you can form a binding agreement under the laws that apply to you, and
          you’re at least 13 years old. If you’re using Gear for an organization, you confirm you’re
          allowed to accept these terms on its behalf.
        </p>

        <h2>What Gear is</h2>
        <p>
          Gear is a free tool for making and sharing packing lists. There are no accounts. A list’s
          private edit link is the only key to changing it; a separate read-only link lets others
          view it, and you can publish a list to a public feed.
        </p>

        <h2>The edit link is your responsibility</h2>
        <p>
          Anyone who has a list’s edit link can change that list. Keep it private and save it
          somewhere safe. If you lose it and haven’t saved it elsewhere, we can’t recover edit
          access for you.
        </p>

        <h2>Your content</h2>
        <ul>
          <li>You keep ownership of the lists and content you create.</li>
          <li>
            By sharing or publishing a list, you give us permission to store, copy, and display that
            content so the feature works. This permission ends when you remove the content.
          </li>
          <li>
            You’re responsible for what you put in your lists, and you confirm you have the right to
            share it and that it doesn’t break the law or these terms.
          </li>
          <li>
            Public means public. A published or shared list can be viewed by anyone with the link.
            Don’t share anything you wouldn’t want to be public.
          </li>
        </ul>

        <h2>Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>post illegal, harmful, deceptive, infringing, or abusive content;</li>
          <li>use Gear to spam, harass, or impersonate others;</li>
          <li>break, overload, probe, or interfere with the service or its security;</li>
          <li>scrape or use the service to build a competing dataset without permission.</li>
        </ul>

        <h2>Reporting and removals</h2>
        <p>
          Public lists can be flagged with the “Report” button. To report a problem, claim that
          content infringes your rights, or request a takedown, email
          <a href="mailto:ryanekiley@gmail.com">ryanekiley@gmail.com</a> with enough detail to
          identify the content. We may remove content or limit access — including taking lists off
          the public feed — at our discretion, especially in response to reports.
        </p>

        <h2>Our rights</h2>
        <p>
          Gear, including its name, design, code, and the gear catalog as a whole, belongs to us and
          is protected by intellectual property laws. These terms don’t give you any right to our
          branding or to copy the service.
        </p>

        <h2>Availability</h2>
        <p>
          Gear is offered as a free service and may change, pause, or be discontinued at any time
          without notice. We don’t guarantee it will always be available or that data will be
          retained indefinitely. Keep your own backups of anything important (the editor can export
          your list).
        </p>

        <h2>No warranty — don’t bet your safety on it</h2>
        <p>
          Gear is provided “as is” and “as available,” without warranties of any kind, whether
          express or implied, to the fullest extent allowed by law. Weights, the catalog, and totals
          may be wrong, incomplete, or out of date. Don’t rely on Gear for anything safety-critical
          — verify your own kit before you head out.
        </p>

        <h2>Limit of liability</h2>
        <p>
          To the fullest extent allowed by law, Gear and its operator won’t be liable for any
          indirect, incidental, special, or consequential damages, or for any loss of data, arising
          from your use of (or inability to use) the service. Where liability can’t be excluded, it’s
          limited to the amount you paid to use Gear — which, for a free service, is zero.
        </p>

        <h2>Your responsibility to us</h2>
        <p>
          You agree to cover reasonable costs and claims that arise from content you post or from
          your misuse of Gear, to the extent allowed by law.
        </p>

        <h2>Ending access</h2>
        <p>
          You can stop using Gear at any time. We may suspend or end your access if you break these
          terms or to protect the service or its users.
        </p>

        <h2>Governing law</h2>
        <p>
          These terms are governed by the laws of the State of Oregon, USA, without regard to its
          conflict-of-laws rules. Any dispute will be handled in the state or federal courts located
          in Oregon, unless the law that applies to you requires otherwise.
        </p>

        <h2>General</h2>
        <p>
          If any part of these terms is found unenforceable, the rest still applies. Our not
          enforcing a term isn’t a waiver of it. These terms, with the
          <NuxtLink to="/privacy">Privacy Policy</NuxtLink>, are the whole agreement between us about
          Gear. You may not transfer your rights under them; we may transfer ours if Gear changes
          hands.
        </p>

        <h2>Changes to these terms</h2>
        <p>
          We may update these terms. We’ll change the “last updated” date above when we do.
          Continuing to use Gear after a change means you accept the updated terms.
        </p>

        <h2>Contact</h2>
        <p>
          Questions: <a href="mailto:ryanekiley@gmail.com">ryanekiley@gmail.com</a>.
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
</style>
