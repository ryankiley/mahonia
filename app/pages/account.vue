<script setup lang="ts">
import { KeyRound } from "@lucide/vue";
import type { PasskeySummary } from "~/composables/usePasskeys";

// Your account. Deliberately the whole of it: a way back in, an optional display
// name, your passkeys, and the way out. No avatar, no bio, no profile — an account
// exists so your gear and lists follow you, not so there's someone to be on this
// site.
//
// Every account has an address, whichever way it was made — a passkey identifies
// you, and the address is the way back in when every authenticator is lost. So the
// email here is a fact, not a slot: there is no unrecoverable state to warn about.
//
// It lives here rather than at the bottom of /vault so the vault page can be about
// gear and nothing else.
useHead({
  title: "Your account — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

const { user, signedIn, loaded, refresh, requestLink, signOut, saveProfile } = useSession();
const { confirm: askConfirm } = useDialogs();
const pk = usePasskeys();
// whether this browser can do WebAuthn at all — resolved on mount, so the
// signed-out view offers the passkey door only where it actually opens
const canPasskey = ref(false);
onMounted(() => {
  refresh();
  canPasskey.value = passkeysSupported();
});

// ---- signed out: two jobs, one page ---------------------------------------
// Signing in and creating an account are NOT the same task and don't share copy.
// Signing in should be one tap and needs no explanation; creating asks for an
// address and owes you a reason. So the surface has a mode, and defaults to
// signing in — after launch that's the overwhelmingly common reason to be here.
const mode = ref<"signin" | "create">("signin");

// ---- signing in ----------------------------------------------------------
const signingIn = ref(false);
const signinNote = ref("");
async function signInWithPasskey() {
  signingIn.value = true;
  signinNote.value = "";
  const r = await pk.signIn();
  signingIn.value = false;
  if (r === "ok") return;
  signinNote.value =
    r === "unsupported"
      ? "This browser can’t use passkeys. Ask for a link instead."
      : r === "cancelled"
        ? ""
        : "No passkey matched. Ask for a link instead, or create an account.";
}

const linkEmail = ref("");
const linkSending = ref(false);
const linkNote = ref("");
async function sendLink() {
  const email = linkEmail.value.trim();
  if (!email || linkSending.value) return;
  linkSending.value = true;
  linkNote.value = "";
  const r = await requestLink(email);
  linkSending.value = false;
  // "sent" is the same answer for a known and an unknown address — the endpoint
  // deliberately can't tell you which, so neither can this.
  linkNote.value =
    r === "sent"
      ? `Check ${email} for a link.`
      : r === "unavailable"
        ? "Sign-in links aren’t set up on this deployment yet."
        : "Couldn’t send that. Check the address and try again.";
}

// ---- creating an account -------------------------------------------------
const signupEmail = ref("");
const creating = ref(false);
const createNote = ref("");
async function createWithPasskey() {
  const email = signupEmail.value.trim();
  if (!email || creating.value) return;
  creating.value = true;
  createNote.value = "";
  const r = await pk.signUp(email);
  creating.value = false;
  if (r === "ok") return;
  createNote.value =
    r === "taken"
      ? "That address already has an account. Sign in with a link instead."
      : r === "bad-email"
        ? "That doesn’t look like an email address."
        : r === "unsupported"
          ? "This browser can’t make a passkey. Use a sign-in link instead."
          : r === "cancelled"
            ? ""
            : "Couldn’t create the passkey. Try again?";
}

// ---- display name --------------------------------------------------------
const name = ref("");
const nameSaving = ref(false);
const nameNote = ref("");
watch(
  () => user.value?.displayName,
  (v) => (name.value = v ?? ""),
  { immediate: true },
);
const nameDirty = computed(() => name.value.trim() !== (user.value?.displayName ?? ""));

async function saveName() {
  if (!nameDirty.value || nameSaving.value) return;
  nameSaving.value = true;
  nameNote.value = "";
  const ok = await saveProfile({ displayName: name.value.trim() });
  nameSaving.value = false;
  nameNote.value = ok
    ? name.value.trim()
      ? "Saved. Lists you make now carry your name."
      : "Cleared. Your lists are anonymous again."
    : "Couldn’t save that. Try again?";
}

// ---- passkeys ------------------------------------------------------------
const passkeys = ref<PasskeySummary[]>([]);
const pkBusy = ref(false);
const pkNote = ref("");

async function loadPasskeys() {
  if (!signedIn.value || !canPasskey.value) return;
  passkeys.value = await pk.list();
}
watch([signedIn, canPasskey], () => loadPasskeys(), { immediate: true });

async function addPasskey() {
  pkBusy.value = true;
  pkNote.value = "";
  const result = await pk.register(deviceLabel());
  pkBusy.value = false;
  if (result === "ok") {
    pkNote.value = "Added. You can sign in with it from now on.";
    await loadPasskeys();
  } else if (result === "failed") pkNote.value = "That didn’t work. Try again?";
  // "cancelled" is a choice, not a failure — say nothing
}

async function removePasskey(id: number) {
  if (!(await askConfirm({
    title: "Remove this passkey",
    message:
      "Remove this passkey? You can still sign in with an emailed link, and add another any time.",
    confirmLabel: "Remove",
  }))) return;
  if (await pk.remove(id)) await loadPasskeys();
}

// A rough, honest name for the device being enrolled, so the list means something
// later. Best-effort from the user agent — a label, never a security decision.
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android device";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux";
  return "This device";
}

async function onSignOut() {
  await signOut();
  // drop both per-account memos so the next person to sign in on this device
  // starts clean rather than inheriting "already sent" / "already claimed"
  resetVaultCapture();
  useClaimedLists().resetClaimMark();
  await navigateTo("/vault");
}
</script>

<template>
  <div>
    <SiteTopbar>
      <NuxtLink to="/vault" class="btn btn--link">Your vault</NuxtLink>
    </SiteTopbar>

    <main id="main-content" tabindex="-1" class="wrap page">
      <h1 class="t-title acct__head">Your account</h1>

      <ClientOnly>
        <!-- Centred and narrow: signed out there is exactly one thing to do here,
             so the page shouldn't read as a form with a column of chrome beside it. -->
        <!-- Centred and narrow: signed out there is exactly one thing to do here,
             so the page shouldn't read as a form with a column of chrome beside it. -->
        <div v-if="loaded && !signedIn" class="acct__empty">
          <!-- SIGN IN. A passkey is one tap and nothing typed, so it leads; the
               link is the fallback for a device that doesn't hold one yet. -->
          <template v-if="mode === 'signin'">
            <button
              v-if="canPasskey"
              type="button"
              class="btn btn--primary acct__wide"
              :disabled="signingIn"
              @click="signInWithPasskey"
            >
              <KeyRound :size="15" :stroke-width="2" />
              {{ signingIn ? "Waiting for your device…" : "Sign in with a passkey" }}
            </button>
            <p v-if="signinNote" class="t-sm acct__note">{{ signinNote }}</p>

            <!-- These are ALTERNATIVES, not steps — the rule says so where stacked
                 buttons alone would read as a sequence. The one place this page
                 draws a line at all; see atoms/controls.scss on borders being rare. -->
            <p v-if="canPasskey" class="acct__or"><span>or</span></p>

            <form class="acct__signup" @submit.prevent="sendLink">
              <input
                v-model="linkEmail"
                class="field acct__input"
                type="email"
                autocomplete="email"
                placeholder="you@example.com"
                aria-label="Email address"
              />
              <button
                type="submit"
                class="btn"
                :class="canPasskey ? 'acct__alt' : 'btn--primary'"
                :disabled="linkSending || !linkEmail.trim()"
              >
                {{ linkSending ? "Sending…" : "Email me a link" }}
              </button>
            </form>
            <p v-if="linkNote" class="t-sm acct__note">{{ linkNote }}</p>

            <p class="t-sm t-muted">
              New here?
              <button type="button" class="acct__switch" @click="mode = 'create'">
                Create an account
              </button>
            </p>
          </template>

          <!-- CREATE. Needs an address, and owes a reason for asking. -->
          <template v-else>
            <form class="acct__signup" @submit.prevent="createWithPasskey">
              <input
                v-model="signupEmail"
                class="field acct__input"
                type="email"
                autocomplete="email"
                placeholder="you@example.com"
                aria-label="Email address"
              />
              <button
                type="submit"
                class="btn btn--primary"
                :disabled="creating || !signupEmail.trim() || !canPasskey"
              >
                <KeyRound :size="15" :stroke-width="2" />
                {{ creating ? "Waiting for your device…" : "Create account with a passkey" }}
              </button>
            </form>
            <p class="t-sm t-muted acct__aside">
              Your face, fingerprint or screen lock. The address is only how you get back in if
              you lose your devices.
            </p>
            <p v-if="createNote" class="t-sm acct__note">{{ createNote }}</p>

            <p class="t-sm t-muted">
              Already have one?
              <button type="button" class="acct__switch" @click="mode = 'signin'">
                Sign in
              </button>
            </p>
          </template>
        </div>

        <div v-else-if="loaded && signedIn" class="acct__body">
          <section class="acct__section">
            <h2 class="t-label acct__label">Email</h2>
            <p class="acct__value">{{ user?.email }}</p>
            <p class="t-sm t-muted">
              The only thing an account stores about you. Lose every device and a link sent here
              is how you get back to your gear.
            </p>
          </section>

          <section class="acct__section">
            <h2 class="t-label acct__label">Display name</h2>
            <form class="acct__row" @submit.prevent="saveName">
              <input
                v-model="name"
                class="field acct__input"
                type="text"
                maxlength="40"
                placeholder="Optional"
                aria-label="Display name"
              />
              <button type="submit" class="btn btn--quiet" :disabled="!nameDirty || nameSaving">
                {{ nameSaving ? "Saving…" : "Save" }}
              </button>
            </form>
            <p class="t-sm t-muted">
              Shown on lists you share or publish. Leave it empty and they stay anonymous —
              your email is never shown to anyone.
            </p>
            <p v-if="nameNote" class="t-sm acct__note">{{ nameNote }}</p>
          </section>

          <section v-if="canPasskey" class="acct__section">
            <div class="acct__sectionhead">
              <h2 class="t-label acct__label">Passkeys</h2>
              <button type="button" class="btn btn--quiet acct__add" :disabled="pkBusy" @click="addPasskey">
                <KeyRound :size="14" aria-hidden="true" /> Add
              </button>
            </div>
            <ul v-if="passkeys.length" class="acct__list">
              <li v-for="k in passkeys" :key="k.id" class="acct__item">
                <span>{{ k.label || "Passkey" }}</span>
                <span class="t-sm t-muted acct__meta">
                  {{ k.lastUsedAt ? `last used ${timeAgo(Date.parse(k.lastUsedAt))}` : "not used yet" }}
                </span>
                <button type="button" class="btn btn--quiet" @click="removePasskey(k.id)">Remove</button>
              </li>
            </ul>
            <p class="t-sm t-muted">
              Sign in with your fingerprint or screen lock instead of waiting for an email. The
              email link always keeps working, so removing them all locks nothing.
            </p>
            <p v-if="pkNote" class="t-sm acct__note">{{ pkNote }}</p>
          </section>

          <section class="acct__section">
            <button type="button" class="btn btn--quiet acct__signout" @click="onSignOut">Sign out</button>
          </section>
        </div>

        <p v-else class="t-muted">Loading…</p>

        <template #fallback>
          <p class="t-muted">Loading…</p>
        </template>
      </ClientOnly>
    </main>
  </div>
</template>

<style scoped lang="scss">
.page {
  padding-block: var(--space-5) var(--space-9);
}
.acct__head {
  margin-bottom: var(--space-6);
}
.acct__body {
  display: flex;
  flex-direction: column;
  max-width: 52ch;
}
/* one rhythm for every block: a hairline above, the same padding below it. The
   sections differ in content, never in spacing. */
/* Signed out there is exactly one thing to do, so the column centres and narrows
   rather than sitting left in a full-width page beside empty space. */
.acct__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  max-width: 26rem;
  margin-inline: auto;
  padding-block: var(--space-5) var(--space-6);
  text-align: center;
}
/* The secondary action. The system is deliberately de-outlined (see
   atoms/controls.scss), so this gets a quiet FILL rather than a border — it reads
   as a button at rest without introducing the one device that file rules out. */
.acct__empty .acct__wide {
  width: 100%;
}
/* "or" sitting in a hairline. The rule is drawn with a flex child either side
   rather than a pseudo-element on the text, so it centres correctly whatever the
   word's width and needs no background-matching trick to punch the gap. */
.acct__or {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-sm);
}
.acct__or::before,
.acct__or::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: var(--line);
}
/* A mode switch, not a navigation — it swaps the form in place, so it's a button
   that reads as a link rather than an anchor that goes nowhere. */
.acct__switch {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--ink);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.acct__empty .acct__alt {
  width: 100%;
  background: var(--paper-2);
  color: var(--ink-2);
}
.acct__empty .acct__alt:hover {
  background: var(--paper-3);
  color: var(--ink);
}
.acct__empty .acct__input {
  width: 100%;
  text-align: center;
}
.acct__signup {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
  width: 100%;
}
.acct__aside {
  margin: 0;
  max-width: 46ch;
}
.acct__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-block: var(--space-5);
}
.acct__section + .acct__section {
  border-top: 1px solid var(--line);
}
.acct__section:first-child {
  padding-top: 0;
}
.acct__label {
  color: var(--ink-2);
}
.acct__value {
  color: var(--ink);
}
.acct__sectionhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.acct__add {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.acct__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
/* .field is borderless by design (it lives in list rows); a standalone form field
   needs the bottom rule the editor's title field uses to read as editable */
.acct__input {
  flex: 1 1 auto;
  min-width: 0;
  border-bottom: 1px solid var(--line);
}
.acct__input:focus {
  border-bottom-color: var(--ink-2);
}
.acct__row .btn {
  flex: none;
}
/* a select is intrinsically sized; keep it narrow rather than letting it span the
   column like the text field does */
.acct__select {
  align-self: flex-start;
  width: auto;
  min-width: 8rem;
  border-bottom: 1px solid var(--line);
}
/* the section is a flex COLUMN, so a bare button stretches and its label centres —
   pull it back to the left edge every other line sits on */
.acct__signout {
  align-self: flex-start;
}
.acct__note {
  color: var(--ink);
}
.acct__list {
  list-style: none;
  display: flex;
  flex-direction: column;
}
.acct__item {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding-block: var(--space-3);
}
.acct__item + .acct__item {
  border-top: 1px solid var(--line);
}
.acct__meta {
  flex: 1 1 auto;
}
</style>
