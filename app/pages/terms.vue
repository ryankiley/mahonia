<script setup lang="ts">
// CONTACT_EMAIL is auto-imported from app/utils/site.
useHead({
  title: "Terms — Mahonia",
  meta: [{ name: "description", content: "The terms for using Mahonia." }],
});
</script>

<template>
  <div>
    <SiteTopbar>
      <span class="t-sm t-muted">Terms</span>
    </SiteTopbar>

    <main class="wrap page">
      <div class="prose">
        <h1 class="t-title">Terms of Use</h1>
        <p class="t-sm t-muted">Last updated 26 June 2026</p>

        <p>
          These terms cover your use of Mahonia. They’re written to be readable, not to trap you. Mahonia
          is made by one person, it’s free, and it has no accounts. By using it you agree to what’s
          below. If you don’t agree, that’s completely fine — just don’t use it.
        </p>

        <h2>What Mahonia is</h2>
        <p>
          Mahonia is a free tool for making and sharing packing lists. A list’s private edit link is
          the only key to changing it; a separate read-only link lets others view it, and you can
          publish a list to a public feed.
        </p>

        <h2>The edit link is your responsibility</h2>
        <p>
          Anyone who has a list’s edit link can change that list. Keep it private and save it
          somewhere safe. If you lose it and haven’t saved it elsewhere, I can’t recover edit access
          for you.
        </p>

        <h2>Your content is yours</h2>
        <p>
          You keep ownership of the lists you create. By sharing or publishing one, you give me
          permission to store and display it so the feature works — and that permission ends when you
          remove the content. You’re responsible for what you put in your lists and for having the
          right to share it. Public means public: a published or shared list can be read by anyone
          with the link, so don’t share anything you wouldn’t want out in the open.
        </p>

        <h2>Fair use of Mahonia</h2>
        <p>
          Please don’t use Mahonia to break the law, infringe others’ rights, post abusive or deceptive
          content, impersonate people, or attack, overload, or scrape the service. Public lists can
          be flagged with the “Report” button; to report a problem or request a takedown, email
          <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a> with enough detail to find the
          content. I may remove content or limit access — including pulling lists off the public feed
          — especially in response to reports.
        </p>

        <h2>It’s free and provided “as is”</h2>
        <p>
          Mahonia is offered free of charge and may change, pause, or shut down at any time, and isn’t
          guaranteed to keep your data forever — so keep your own backups of anything important (the
          editor can export your list). It’s provided <strong>as is</strong> and
          <strong>as available</strong>, with no warranties of any kind, to the fullest extent the
          law allows. Weights, the catalog, and totals may be wrong or out of date, so don’t rely on
          Mahonia for anything safety-critical — verify your own kit before you head out.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, I’m not liable for any indirect, incidental, or
          consequential damages, or for any loss of data, arising from your use of (or inability to
          use) Mahonia. As a free service, it comes with no guarantee of availability, accuracy, or
          fitness for any particular purpose.
        </p>

        <h2>Changes</h2>
        <p>
          These terms may change as Mahonia grows. Material changes will be reflected here with a new
          date. Continuing to use Mahonia after a change means you accept the updated terms.
        </p>

        <h2>Governing law</h2>
        <p>
          These terms are governed by the laws of the State of Oregon, United States, without regard
          to its conflict-of-laws rules. Nothing here limits any rights you have under the mandatory
          laws of the place you live.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms: <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>.
          See also the <NuxtLink to="/privacy">Privacy</NuxtLink> page.
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page {
  padding-block: var(--space-5) var(--space-9);
}
</style>
