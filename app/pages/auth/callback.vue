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
// IN THE BROWSER THAT ASKED, that is. Anywhere else the server answers `confirm`
// and spends nothing, and this page names the account and waits for a yes: a link
// is a way into whichever account asked for it, and one a stranger sent you would
// otherwise sign this browser in as them and hand their account its lists (see
// redeemMagicLink in server/utils/authSession.ts). The lists are then a question
// of their own, after the sign-in and not part of it.
//
// noindex + no SSR data: the token lives in the query string and must not reach a
// crawler, a cache, or a server-rendered payload.
useHead({
  title: "Signing you in — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

const route = useRoute();
const { refresh, allowListSweep } = useSession();

type State = "working" | "confirm" | "lists" | "done" | "invalid" | "error";
const state = ref<State>("working");
/** what the server said when it wanted a yes: whose account, whether any browser
 *  asked for this link, and whether signing in clears out whoever was there first */
const asking = ref({ email: "", asked: true, evicts: false });
/** the yes: sent with the token from then on, so "Try again" doesn't ask twice */
let confirmed = false;
const addFailed = ref(false);

// the lists this browser made: what the second question is about
const deviceLists = computed(() => useMyLists().entries.value.filter((e) => e.origin !== "opened").length);

type VerifyAnswer =
  | { ok: true; sweep: boolean }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "confirm"; email: string; asked: boolean; evicts: boolean };

// A PRESS IS ONLY AN ANSWER IF THE QUESTION WAS THERE FIRST. Another site can open
// this page under a click the person is already making for something else: the
// second half of a double-click, or the one that brings this window forward. So a
// press counts only once its question has been on screen, in a focused window,
// for a moment. Nobody reads "Sign in as …?" faster than this. The button shows
// it (disabled until then), so a press that came too soon is seen not to have
// landed rather than seeming to do nothing.
const READ_MS = 700;
const armed = ref(false);
let arming: ReturnType<typeof setTimeout> | undefined;
function rearm() {
  armed.value = false;
  clearTimeout(arming);
  arming = setTimeout(() => (armed.value = true), READ_MS);
}
function ask(question: "confirm" | "lists") {
  rearm();
  state.value = question;
}
onMounted(() => {
  window.addEventListener("focus", rearm);
  document.addEventListener("visibilitychange", rearm);
});
onBeforeUnmount(() => {
  clearTimeout(arming);
  window.removeEventListener("focus", rearm);
  document.removeEventListener("visibilitychange", rearm);
});

function confirm() {
  if (!armed.value) return;
  confirmed = true;
  void verify();
}

async function verify() {
  const raw = route.query.t;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  if (!token) {
    state.value = "invalid";
    return;
  }
  state.value = "working";
  try {
    const res = await $fetch<VerifyAnswer>("/api/auth/verify", {
      method: "POST",
      body: confirmed ? { token, confirmed } : { token },
    });
    if (!res.ok) {
      if (res.reason === "invalid") state.value = "invalid";
      else {
        asking.value = { email: res.email, asked: res.asked, evicts: res.evicts };
        ask("confirm");
      }
      return;
    }
    // re-read the session so the rest of the app sees the new cookie
    await refresh(true);
    tally("sign_in");
    // THE LISTS ARE A SECOND QUESTION. A sign-in this browser asked for brings the
    // lists it made into the account (`sweep`). One that was only confirmed here
    // doesn't: the yes above is one press, and one press is what a stranger's link
    // is after, so it signs in and takes nothing with it. With no lists here there
    // is nothing to take and nothing to ask: what this browser makes from now on,
    // it makes signed in.
    if (!res.sweep) {
      if (deviceLists.value > 0) return ask("lists");
      await allowListSweep();
    }
    await finish();
  } catch {
    // network or rate limit — distinct from a bad token, and worth retrying
    state.value = "error";
  }
}

async function addLists() {
  if (!armed.value) return;
  addFailed.value = !(await allowListSweep());
  if (!addFailed.value) await finish();
}

/** Hand the person to the thing they signed in for: back where they started if we
 *  still know, /gear if not. The magic link usually returns in a new tab, which is
 *  exactly why the return path is in localStorage rather than sessionStorage. */
async function finish() {
  state.value = "done";
  await useReturnTo().resume("/gear");
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

      <template v-else-if="state === 'confirm'">
        <h1 class="t-title cb__account">Sign in as {{ asking.email }}?</h1>
        <p class="t-muted cb__line">
          {{
            asking.asked
              ? "This link was asked for in a different browser. Carry on only if you asked for it."
              : "Carry on only if this address is yours."
          }}
        </p>
        <p v-if="asking.evicts" class="t-muted cb__line">
          Signing in removes any passkey already on this account and signs out anyone else using it.
        </p>
        <div class="cb__actions">
          <button type="button" class="btn btn--primary" :disabled="!armed" @click="confirm">Sign in</button>
          <NuxtLink to="/" class="btn btn--quiet">Not me</NuxtLink>
        </div>
      </template>

      <template v-else-if="state === 'lists'">
        <h1 class="t-title">Add this browser’s {{ deviceLists === 1 ? "list" : "lists" }} to your account?</h1>
        <p class="t-muted cb__line cb__account">
          You’re signed in as {{ asking.email }}.
          {{ deviceLists === 1 ? "The list" : `The ${deviceLists} lists` }} made in this browser
          {{ deviceLists === 1 ? "isn’t" : "aren’t" }} in that account yet. Adding
          {{ deviceLists === 1 ? "it puts it" : "them puts them" }} wherever you sign in.
        </p>
        <p v-if="addFailed" class="t-muted cb__line">That didn’t go through. Try again, or carry on without.</p>
        <div class="cb__actions">
          <button type="button" class="btn btn--primary" :disabled="!armed" @click="addLists">
            {{ deviceLists === 1 ? "Add list" : "Add lists" }}
          </button>
          <button type="button" class="btn btn--quiet" @click="finish">Not now</button>
        </div>
      </template>

      <template v-else-if="state === 'invalid'">
        <h1 class="t-title">That link has expired</h1>
        <p class="t-muted cb__line">
          Sign-in links work once and last 15 minutes. Ask for a fresh one and it’ll be along
          in a moment.
        </p>
        <NuxtLink to="/account" class="btn btn--primary cb__action">Get a new link</NuxtLink>
      </template>

      <template v-else>
        <h1 class="t-title">Couldn’t sign you in</h1>
        <p class="t-muted cb__line">
          Something went wrong on the way. Your link is probably still good.
        </p>
        <button type="button" class="btn btn--primary cb__action" @click="verify">Try again</button>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.cb__line {
  max-width: 52ch;
}
.cb__account {
  overflow-wrap: anywhere;
}
.cb__action,
.cb__actions {
  margin-top: var(--space-3);
}
.cb__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
