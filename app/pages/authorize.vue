<script setup lang="ts">
// /authorize — the connector's sign-in and consent page, where Claude (or any OAuth
// client) sends a person so their assistant can reach My Gear.
//
// Two states on one page, decided by the session. Signed out, it is the same sign-in
// surface /account shows, mounted the way the modal mounts it so a finished sign-in
// stays here instead of navigating away; the page simply re-renders as the consent
// once there is an account. Signed in, it names the app asking and what it wants,
// and Allow or Deny sends the person back to the app with the answer.
//
// The request in the URL is checked by the server (/api/oauth/authorize) before
// anything is shown, so a client that isn't one, or a redirect that isn't the
// client's, gets a page that says so and never a redirect. Everything else about a
// bad request goes back to the client as the error it asked to receive.
//
// Opened in a popup by Claude's apps, and by a terminal client's browser for Claude
// Code; in both the magic-link sign-in may finish in ANOTHER tab, because the link is
// clicked from a mail app. Two things cover that: the return path is remembered so
// the tab the link opens lands here too, and this tab looks for the session's hint
// cookie every few seconds while signed out — a cookie read, nothing more, until the
// other tab has set it — so it moves on to the consent the moment that happens. The
// window Claude is watching is this one.
import type { AccessScope } from "~~/shared/types";

useHead({
  title: "Connect — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

const route = useRoute();
const { user, signedIn, presence, hasSessionHint, refresh, signOut } = useSession();

type Checked =
  | { ok: true; client: { label: string; kind: "document" | "registered" }; level: AccessScope; returnTo: { host: string; loopback: boolean } }
  | { ok: false; error: string; description: string; redirect: string | null; auto: boolean };
const { data: checked } = await useFetch<Checked>("/api/oauth/authorize", { query: route.query, key: `authorize:${route.fullPath}` });

// A request the client should hear about goes back to it as an error. Without a
// click only when the server says the redirect is the client's own host (the GET's
// `auto`): any redirect a stranger could register gets a link instead, so this page
// is never a bounce from mahonia.app to wherever a crafted URL says.
if (import.meta.client && checked.value && !checked.value.ok && checked.value.redirect && checked.value.auto) {
  window.location.replace(checked.value.redirect);
}
const errorBack = computed(() => (checked.value && !checked.value.ok && checked.value.redirect ? { href: checked.value.redirect, host: new URL(checked.value.redirect).host } : null));

const label = computed(() => (checked.value?.ok ? checked.value.client.label : ""));
const wants = computed(() =>
  checked.value?.ok && checked.value.level === "write"
    ? "read your My Gear and change it, and file the lists it makes under your account"
    : "read your My Gear",
);

onMounted(() => {
  refresh();
  // the tab an emailed link opens comes back to this exact request
  useReturnTo().remember(route.fullPath);
});
// while signed out, look for the hint cookie every few seconds and re-read the
// session only once it is there: an idle tick costs a cookie read and nothing else
let poll: ReturnType<typeof setInterval> | undefined;
watch(
  signedIn,
  (on) => {
    if (poll) clearInterval(poll);
    poll = undefined;
    if (!on && import.meta.client) {
      poll = setInterval(() => {
        if (document.visibilityState === "visible" && hasSessionHint()) refresh(true);
      }, 3_000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => poll && clearInterval(poll));

const deciding = ref(false);
const note = ref("");
async function decide(decision: "allow" | "deny") {
  if (deciding.value) return;
  deciding.value = true;
  note.value = "";
  try {
    const res = await $fetch<{ ok: boolean; redirect?: string | null; description?: string }>("/api/oauth/authorize", {
      method: "POST",
      body: { ...route.query, decision },
    });
    if (res.redirect) {
      note.value = `Sending you back to ${checked.value?.ok ? checked.value.returnTo.host : "the app"}…`;
      window.location.assign(res.redirect);
      return;
    }
    note.value = res.description ?? "That didn’t work. Try again?";
  } catch {
    note.value = "Couldn’t send your answer. Try again?";
  }
  deciding.value = false;
}
</script>

<template>
  <div>
    <SiteTopbar label="Connect" />
    <main id="main-content" tabindex="-1" class="wrap page">
      <!-- a request that failed: say so, and offer the way back when there is one -->
      <template v-if="checked && !checked.ok">
        <h1 class="t-title">This connection can’t be made</h1>
        <p class="t-muted az__line">{{ checked.description }}</p>
        <p class="t-sm t-muted az__line">
          Nothing was changed on your account. Try adding the connector again from the app that sent you here.
        </p>
        <a v-if="errorBack" :href="errorBack.href" class="btn btn--ghost az__deny">Return to {{ errorBack.host }}</a>
      </template>

      <template v-else-if="checked">
        <h1 class="t-title">Connect {{ label }} to Mahonia</h1>

        <ClientOnly>
          <!-- SIGNED OUT: the account surface, exactly as the modal mounts it, so a
               sign-in finishes here rather than leaving for /gear -->
          <template v-if="presence === 'signedOut'">
            <p class="t-muted az__line">
              Sign in to your Mahonia account first. {{ label }} will then ask to {{ wants }}.
            </p>
            <div class="az__signin">
              <AccountView in-modal hide-heading />
            </div>
          </template>

          <!-- SIGNED IN: the consent -->
          <template v-else-if="signedIn">
            <p class="az__line">
              <strong>{{ label }}</strong> is asking to {{ wants }}.
            </p>
            <ul class="t-sm t-muted az__facts">
              <li>It stays connected until you disconnect it under Assistant access on your account page.</li>
              <li>
                Afterwards you’ll be sent to <code>{{ checked.returnTo.host }}</code
                ><template v-if="checked.returnTo.loopback"
                  >, an app running on this computer. Any program here could listen at that address, so
                  only allow this if you just started the connection yourself.</template
                >
              </li>
              <li v-if="checked.client.kind === 'registered'">The app registered itself under that name; Mahonia hasn’t checked who runs it.</li>
            </ul>
            <div class="az__actions">
              <button type="button" class="btn btn--primary" :disabled="deciding" @click="decide('allow')">Allow</button>
              <button type="button" class="btn btn--ghost az__deny" :disabled="deciding" @click="decide('deny')">Deny</button>
            </div>
            <p v-if="note" class="t-sm az__note">{{ note }}</p>
            <p class="t-sm t-muted az__line">
              Signed in as {{ user?.email }}.
              <button type="button" class="az__switch" @click="signOut">Not you?</button>
            </p>
          </template>

          <p v-else class="t-muted">Loading…</p>
          <template #fallback>
            <p class="t-muted">Loading…</p>
          </template>
        </ClientOnly>
      </template>

      <p v-else class="t-muted">Loading…</p>
    </main>
  </div>
</template>

<style scoped lang="scss">
.page {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
}
.az__line {
  max-width: 52ch;
}
.az__signin {
  width: 100%;
  max-width: var(--account-measure);
}
.az__facts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 52ch;
  padding-left: 1.2em;
}
.az__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-2);
}
.az__deny {
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
}
.az__note {
  color: var(--ink);
}
/* the same link-shaped button the account surface uses to switch modes */
.az__switch {
  color: var(--ink);
  font-weight: 600;
  text-decoration: underline;
  text-decoration-color: var(--underline);
  text-underline-offset: var(--underline-offset);
}
.az__switch:hover,
.az__switch:focus-visible {
  text-decoration-color: var(--ink-2);
}
</style>
