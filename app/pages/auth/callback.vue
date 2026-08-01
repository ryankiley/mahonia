<script setup lang="ts">
// Where the emailed sign-in link lands.
//
// WHY A PAGE AND NOT A SERVER REDIRECT: mail gateways, link scanners and inbox
// previewers fetch every URL in a message before the human sees it. If the GET
// itself redeemed the token, a single-use link would routinely be spent before it
// arrived and the user would be told their brand-new link had "already been used".
// So this page holds the token and POSTs it to /api/auth/verify — a step a scanner
// doesn't take. It fires on mount without a click, so for the human it's still a
// single tap from the email to being signed in.
//
// noindex + no SSR data: the token lives in the query string and must not reach a
// crawler, a cache, or a server-rendered payload.
definePageMeta({ layout: "default" });
useHead({
  title: "Signing you in — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

const route = useRoute();
const { refresh } = useSession();

type State = "working" | "done" | "invalid" | "error";
const state = ref<State>("working");

async function verify() {
  const raw = route.query.t;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  if (!token) {
    state.value = "invalid";
    return;
  }
  state.value = "working";
  try {
    const res = await $fetch<{ ok: boolean }>("/api/auth/verify", {
      method: "POST",
      body: { token },
    });
    if (!res.ok) {
      state.value = "invalid";
      return;
    }
    // re-read the session so the rest of the app sees the new cookie, then hand
    // the user straight to the thing they signed in for
    await refresh(true);
    state.value = "done";
    await navigateTo("/vault", { replace: true });
  } catch {
    // network or rate limit — distinct from a bad token, and worth retrying
    state.value = "error";
  }
}

onMounted(verify);
</script>

<template>
  <div>
    <SiteTopbar />
    <main id="main-content" tabindex="-1" class="wrap page">
      <template v-if="state === 'working' || state === 'done'">
        <h1 class="t-title">Signing you in…</h1>
        <p class="t-muted cb__line">One moment.</p>
      </template>

      <template v-else-if="state === 'invalid'">
        <h1 class="t-title">That link has expired</h1>
        <p class="t-muted cb__line">
          Sign-in links work once and last 15 minutes. Ask for a fresh one and it’ll be along
          in a moment.
        </p>
        <NuxtLink to="/vault" class="btn btn--primary cb__action">Get a new link</NuxtLink>
      </template>

      <template v-else>
        <h1 class="t-title">Couldn’t sign you in</h1>
        <p class="t-muted cb__line">
          Something went wrong on the way — your link is probably still good.
        </p>
        <button type="button" class="btn btn--primary cb__action" @click="verify">Try again</button>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page {
  padding-block: var(--space-5) var(--space-9);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.cb__line {
  max-width: 52ch;
}
.cb__action {
  margin-top: var(--space-3);
}
</style>
