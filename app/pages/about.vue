<script setup lang="ts">
// CONTACT_EMAIL is auto-imported from app/utils/site.
useHead({
  title: "About — Mahonia",
  meta: [
    {
      name: "description",
      content: "What Mahonia is, and why it's named after the Oregon grape.",
    },
  ],
});
</script>

<template>
  <div>
    <SiteTopbar>
      <span class="t-sm t-muted">About</span>
    </SiteTopbar>

    <main class="wrap page">
      <div class="prose">
        <h1 class="t-title">About</h1>

        <p>
          Mahonia is a no-login tool for building, weighing, and sharing packing lists, made by one
          person. Make a list, see what it weighs, send someone the link — no account, no app, no
          ads. The grams are optional; build a list with zero weights and the totals just stay
          quiet.
        </p>

        <h2>Why “Mahonia”?</h2>
        <p>
          <em>Mahonia</em> is the Oregon grape — the Oregon state flower, and one of the most common
          native plants in the Pacific Northwest woods this tool is built for. It’s an unfussy
          evergreen shrub: holly-shaped leaves, bright yellow flowers in late winter, dusty-blue
          berries. Hardy, understated, and everywhere on the trails around Portland.
        </p>
        <p>
          I wanted a name that was short, a little bit odd, and actually rooted in the place — for a
          domain I’d own outright. Mahonia is a real word with a real place behind it, and it
          doesn’t need explaining. A native plant for a tool about getting outside felt right.
        </p>

        <h2>The short version of how it works</h2>
        <ul>
          <li>Your lists live in your browser until you choose to share one.</li>
          <li>Sharing creates a private edit link and a separate read-only link — no sign-up.</li>
          <li>Weights are backed by a curated, cited gear catalog, but you can override anything.</li>
        </ul>

        <p>
          Questions, or want a list removed? Email
          <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>. See also the
          <NuxtLink to="/privacy">Privacy</NuxtLink> and
          <NuxtLink to="/terms">Terms</NuxtLink> pages.
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
