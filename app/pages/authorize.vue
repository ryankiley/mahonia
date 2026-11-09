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
import { Alert02Icon, Backpack03Icon, SafeBoxIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "~/utils/hugeicon";
import type { IconNode } from "~/utils/hugeicon";
import { clientMark } from "~/utils/clientMark";
import type { AccessScope } from "~~/shared/types";

useHead({
  title: "Connect — Mahonia",
  // no footer: About and Legal are two ways out of a page whose only exits should be
  // Allow and Deny. The layout hides it for a body marked `bare` (layouts/default.vue).
  // A body class and not definePageMeta: page meta goes into the route table in the
  // entry chunk every visitor downloads, and that first load sits at its ceiling.
  bodyAttrs: { class: "bare" },
  meta: [{ name: "robots", content: "noindex" }],
});

const route = useRoute();
const { signedIn, presence, hasSessionHint, refresh } = useSession();

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

const writes = computed(() => checked.value?.ok && checked.value.level === "write");
const wants = computed(() =>
  writes.value
    ? "see and change what’s in My Gear, change the lists filed under your account, and file the lists it makes there"
    : "see what’s in My Gear and which lists are filed under your account",
);
// The same grant as `wants`, a row per thing it reaches, each with the mark that thing
// wears in the app: the safe box is My Gear everywhere, the pack is a list. (Sharing the
// pack with the editor splits it into a first-load chunk of its own, +0.16 KB; the
// ceiling moved for it, see scripts/bundle-budget.mjs.)
const scopes = computed<{ icon: IconNode; text: string }[]>(() =>
  writes.value
    ? [
        { icon: SafeBoxIcon, text: "See and change what’s in My Gear" },
        { icon: Backpack03Icon, text: "Change the lists filed under your account, and file the lists it makes there" },
      ]
    : [
        { icon: SafeBoxIcon, text: "See what’s in My Gear" },
        { icon: Backpack03Icon, text: "See which lists are filed under your account" },
      ],
);
// Who is asking, as the page names and draws them: a logo and our own name for it only
// on a host the server has checked, the app's own name and its initial otherwise
// (utils/clientMark says which is which, and why).
const mark = computed(() => (checked.value?.ok ? clientMark(checked.value.client, checked.value.returnTo) : null));
const label = computed(() => mark.value?.name ?? "");

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
    <SiteTopbar />
    <main id="main-content" tabindex="-1" class="wrap page">
      <!-- one narrow column in the middle: the page is a single decision, and in the
           popup Claude opens it in, the column is simply the window -->
      <div class="az">
        <!-- a request that failed: say so, and offer the way back when there is one -->
        <template v-if="checked && !checked.ok">
          <h1 class="t-title">This connection can’t be made</h1>
          <p class="t-muted">{{ checked.description }}</p>
          <p class="t-muted">Nothing was changed on your account. Try adding the connector again from the app that sent you here.</p>
          <a v-if="errorBack" :href="errorBack.href" class="btn btn--ghost az__deny az__back">Return to {{ errorBack.host }}</a>
        </template>

        <template v-else-if="checked">
          <!-- the two parties, side by side: the app asking, and Mahonia -->
          <div class="az__marks" aria-hidden="true">
            <span class="az__tile">
              <HugeiconsIcon v-if="mark?.icon" :icon="mark.icon" :size="24" :stroke-width="1.5" />
              <span v-else class="az__initial">{{ mark?.initial }}</span>
            </span>
            <span class="az__tie" />
            <span class="az__tile">
              <svg class="az__home" viewBox="0 0 315 367" xmlns="http://www.w3.org/2000/svg">
                <!-- the favicon's M (public/icon.svg), drawn in the page's ink -->
                <path
                  d="M215.25 367C231 304.086 225.75 209.714 199.5 209.714C183.75 209.714 178.5 246.414 194.25 288.357C173.25 272.629 141.75 272.629 120.75 288.357C136.5 246.414 131.25 209.714 115.5 209.714C89.25 209.714 84 304.086 99.75 367C78.75 346.029 26.25 346.029 5.25 367C21 330.3 47.25 288.357 0 241.171C63 193.986 26.25 89.1286 10.5 52.4286C52.5 52.4286 84 26.2143 99.75 0C110.25 83.8857 136.5 157.286 157.5 157.286C178.5 157.286 204.75 83.8857 215.25 0C231 26.2143 262.5 52.4286 304.5 52.4286C283.5 99.6143 267.75 141.557 315 188.743C262.5 235.929 288.75 309.329 309.75 367C288.75 346.029 236.25 346.029 215.25 367Z"
                />
              </svg>
            </span>
          </div>
          <h1 class="t-title">Connect {{ label }} to Mahonia</h1>

          <ClientOnly>
            <!-- SIGNED OUT: the account surface, exactly as the modal mounts it, so a
                 sign-in finishes here rather than leaving for /gear -->
            <template v-if="presence === 'signedOut'">
              <p class="t-muted">Sign in to your Mahonia account first. {{ label }} will then ask to {{ wants }}.</p>
              <div class="az__signin">
                <AccountView in-modal hide-heading as-step />
              </div>
            </template>

            <!-- SIGNED IN: the consent -->
            <template v-else-if="signedIn">
              <section class="az__ask">
                <p class="t-muted">
                  <strong class="az__who-asks">{{ label }}</strong> is asking to:
                </p>
                <ul class="az__scopes">
                  <li v-for="s in scopes" :key="s.text" class="az__scope">
                    <HugeiconsIcon :icon="s.icon" :size="20" :stroke-width="1.5" class="az__scopeicon" aria-hidden="true" />
                    <span>{{ s.text }}</span>
                  </li>
                </ul>
                <p class="t-muted az__fine">Until you disconnect it on your account page, under Assistant access.</p>
              </section>

              <!-- what Mahonia couldn't check, said before the buttons rather than under them -->
              <div v-if="checked.returnTo.loopback || !mark?.checked" class="az__caution">
                <HugeiconsIcon :icon="Alert02Icon" :size="16" :stroke-width="2" class="az__cautionicon" aria-hidden="true" />
                <!-- one short paragraph, whichever of the two applies -->
                <p>
                  <template v-if="!mark?.checked">Mahonia can’t confirm who made this app. </template>
                  <template v-if="checked.returnTo.loopback">
                    Any program on this computer could be listening at <code>{{ checked.returnTo.host }}</code>, so only allow
                    this if you just started it.
                  </template>
                </p>
              </div>

              <!-- who is signed in is the topbar's account disc, and its menu signs out:
                   the page doesn't say it a second time -->
              <div class="az__actions">
                <button type="button" class="btn az__deny" :disabled="deciding" @click="decide('deny')">Deny</button>
                <button type="button" class="btn btn--primary" :disabled="deciding" @click="decide('allow')">Allow</button>
              </div>

              <p v-if="note" class="az__note" role="status">{{ note }}</p>
              <!-- where Allow or Deny takes you; a loopback address is named in the caution -->
              <p v-else-if="!checked.returnTo.loopback" class="t-muted az__fine">You’ll go back to {{ checked.returnTo.host }}.</p>
            </template>

            <p v-else class="t-muted">Loading…</p>
            <template #fallback>
              <p class="t-muted">Loading…</p>
            </template>
          </ClientOnly>
        </template>

        <p v-else class="t-muted">Loading…</p>
      </div>
    </main>
  </div>
</template>

<style scoped lang="scss">
.az {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--account-measure);
  margin-inline: auto;
  /* the topbar is the page's only other furniture, so the column sits a clear step
     below it on a wide window rather than tucked against it */
  padding-top: var(--space-7);
}
@media (max-width: $bp-stack) {
  .az {
    padding-top: var(--space-4);
  }
}

/* ---- the two parties ---- */
.az__marks {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.az__tile {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-3);
  background: var(--paper-2);
  color: var(--ink);
}
.az__initial {
  font-size: var(--text-title);
  font-weight: 600;
  line-height: 1;
}
.az__home {
  width: 22px;
  height: 22px;
  fill: currentColor;
}
/* the tie between them: three dots of the quietest ink, drawn as one dotted rule so
   the gap reads as a connection being made rather than a gap */
.az__tie {
  width: var(--space-6);
  height: 0;
  border-top: 3px dotted var(--ink-3);
}

/* ---- what it asks for ---- */
.az__ask {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-1);
}
.az__who-asks {
  color: var(--ink);
  font-weight: 600;
}
.az__scopes {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
}
.az__scope {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--line);
}
.az__scopeicon {
  flex: none;
  /* centred on the first line of the text beside it: (1.5em line − 20px glyph) / 2 */
  margin-top: calc((1lh - 20px) / 2);
  color: var(--ink-2);
}

/* ---- what Mahonia couldn't check ---- */
.az__caution {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-2);
  background: var(--paper-2);
}
.az__cautionicon {
  flex: none;
  margin-top: calc((1lh - 16px) / 2);
}

/* ---- the decision ---- */
/* two equal halves, the quiet answer first and the filled one where the hand ends —
   the order every dialog in the app uses */
.az__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin-top: var(--space-2);
  gap: var(--space-3);
}
.az__deny {
  border: 1px solid var(--line-2);
}
.az__back {
  align-self: flex-start;
  margin-top: var(--space-2);
}
.az__note {
  color: var(--ink);
}
.az__fine {
  font-size: var(--text-chrome);
}

.az__signin {
  width: 100%;
}
</style>
