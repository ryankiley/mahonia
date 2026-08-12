<script setup lang="ts">
// The account surface itself — sign-in when signed out, settings when signed in.
//
// Mount-agnostic, like ReadonlyListView (which /s and /l both render): the account
// modal shows this over whatever you were doing, and /account renders the same thing
// for a bookmark, a typed URL, or the "Get a new link" button on a dead magic link.
// One implementation, so the two can't drift.
//
// That last part is the whole point of the extraction. The vault went the other way
// and has two — VaultPane and /gear, ~470 lines of template between them, with a
// comment in the page admitting its prompt is copied "WORD FOR WORD" from the pane.
// Signing in and deleting an account are worse things to keep in sync by hand.
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Key01Icon } from "@hugeicons/core-free-icons";
import type { PasskeySummary } from "~/composables/usePasskeys";

// In the MODAL you are already where you want to be, so finishing means closing and
// nothing else. On the PAGE there is no context behind it, so finishing has to take
// you somewhere — back where you came from, or the vault. Same component, one prop,
// rather than two copies that answer this differently.
// `hideHeading`: the modal draws the title itself, in a header row that also carries
// the close button — so the panel must not draw a second one. On the page there is no
// such row and this stays false.
const { inModal = false, hideHeading = false } = defineProps<{ inModal?: boolean; hideHeading?: boolean }>();
const emit = defineEmits<{ done: [] }>();
// Say what this surface is FOR right now. Signed out it is a sign-in dialog, and
// titling it "Your account" describes something you don't have yet — the one thing
// the person in front of it is certain of. Signed in, it's the settings page.
const heading = computed(() =>
  signedIn.value ? "Your account" : mode.value === "create" ? "Create an account" : "Sign in",
);

async function finish(fallback: string) {
  if (inModal) return emit("done");
  await useReturnTo().resume(fallback);
}

// Your account. Deliberately the whole of it: a way back in, an optional display
// name, your passkeys, and the way out. No avatar, no bio, no profile — an account
// exists so your gear and lists follow you, not so there's someone to be on this
// site.
//
// Every account has an address, whichever way it was made — a passkey identifies
// you, and the address is the way back in when every authenticator is lost. So the
// email here is a fact, not a slot: there is no unrecoverable state to warn about.
//
// It lives here rather than at the bottom of /gear so the vault page can be about
// gear and nothing else.
// NO useHead HERE. This is a component with two mounts, and the modal mount renders
// over some OTHER page — so a head call would retitle that page and, worse, stamp its
// own noindex onto it. A public shared list is one of the pages this can open over.
// The title and the noindex belong to /account, which is the thing that is actually
// the account; see the page.

const { user, signedIn, loaded, refresh, requestLink, signOut, saveProfile } = useSession();
const { confirm: askConfirm, confirmState } = useDialogs();
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
  // Back to whatever you were doing. This used to just return, leaving you on the
  // settings page you never came here to read — with no list navigation in the site
  // bar to get out with. /gear is the fallback: it's the one thing an account is
  // FOR, so it's the right landing when there's nowhere to go back to.
  if (r === "ok") return await finish("/gear");
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
  if (r === "taken") {
    // Creating can't sign you in — the ceremony makes a NEW credential, and letting
    // it attach to an existing account would let anyone who knows your address add
    // their own passkey to it. So it switches you instead of leaving you to find
    // the toggle, and carries the address across so it isn't typed twice.
    linkEmail.value = email;
    mode.value = "signin";
    signinNote.value = "You already have an account — sign in with your passkey, or ask for a link.";
    return;
  }
  createNote.value =
    r === "bad-email"
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

// ---- deleting the account ------------------------------------------------
const deleting = ref(false);
const deleteNote = ref("");
// The confirmation, shown after the account is gone and the page has flipped back
// to the signed-out screen. Longer-lived than the usual toast (8s, not the undo
// bar's few): there is nothing to act on, and it's the only acknowledgement that an
// irreversible thing succeeded.
const gone = ref("");
async function deleteAccount() {
  // ONE dialog, two decisions. It used to ask twice — "delete your account?" then
  // "delete your lists too?" — and a second modal arriving after you'd already
  // committed read as a step you hadn't finished rather than a choice you were being
  // offered. The lists still have to be opted INTO: they belong to their edit links
  // and outlive the account by default, so the box starts unticked and the quiet
  // path keeps them.
  if (
    !(await askConfirm({
      title: "Delete your account?",
      message:
        "Your email, display name, passkeys and all your saved gear go, and can't be brought back.",
      confirmLabel: "Delete account",
      checkbox: {
        label: "Delete my lists too",
        // Says what TICKING it does. A hint that explains the unticked state reads
        // backwards under a box you're deciding whether to tick, and this is the
        // consequence people don't anticipate: the lists aren't only yours.
        hint: "Anyone you've shared a link with loses access too.",
      },
    }))
  )
    return;
  const alsoLists = confirmState.checked;

  deleting.value = true;
  deleteNote.value = "";
  try {
    const res = await $fetch<{ listsDeleted: number }>("/api/account/delete", {
      method: "POST",
      body: { deleteLists: alsoLists },
    });
    resetVaultCapture();
    useClaimedLists().resetClaimMark();
    // Stay here rather than navigating away. The page re-renders as the signed-out
    // screen on its own once the session has gone, so the confirmation lands on the
    // thing that actually changed — and a toast that outlived a route change would
    // need app-wide plumbing this is the only caller for.
    await refresh(true);
    const n = res?.listsDeleted ?? 0;
    gone.value = n
      ? `Account deleted, along with ${n} ${n === 1 ? "list" : "lists"}.`
      : "Account deleted. Your lists are untouched.";
    setTimeout(() => (gone.value = ""), 8000);
  } catch {
    deleteNote.value = "Couldn't delete the account. Try again?";
  }
  deleting.value = false;
}

// ---- signing out everywhere ----------------------------------------------
const signingOutAll = ref(false);
async function onSignOutEverywhere() {
  if (
    !(await askConfirm({
      title: "Sign out everywhere?",
      message:
        "Ends every session on every device, including this one. Do this if you think someone else has access — removing a passkey alone doesn't end the sessions it already started.",
      confirmLabel: "Sign out everywhere",
    }))
  )
    return;
  signingOutAll.value = true;
  try {
    await $fetch("/api/auth/signout-all", { method: "POST" });
    resetVaultCapture();
    useClaimedLists().resetClaimMark();
    // Stay put and re-read: in the modal there is nowhere to go (you're already
    // looking at the account), and on the page you're already on /account.
    await refresh(true);
  } catch {
    pkNote.value = "Couldn't sign out everywhere. Try again?";
  }
  signingOutAll.value = false;
}

async function onSignOut() {
  await signOut();
  // drop both per-account memos so the next person to sign in on this device
  // starts clean rather than inheriting "already sent" / "already claimed"
  resetVaultCapture();
  useClaimedLists().resetClaimMark();
  // Signing out of a list you're reading shouldn't also take the list away — in the
  // modal this just closes. The page has nothing behind it, so it goes to /gear.
  await finish("/gear");
}
</script>

<template>
  <div class="acct" :class="{ 'acct--modal': inModal }">
    <h1 v-if="!hideHeading" class="t-title acct__head">{{ heading }}</h1>

    <ClientOnly>
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
            <HugeiconsIcon :icon="Key01Icon" :size="16" :stroke-width="2" />
            {{ signingIn ? "Waiting for your device…" : "Sign in with a passkey" }}
          </button>
          <p v-if="signinNote" class="t-sm acct__note">{{ signinNote }}</p>

          <!-- These are ALTERNATIVES, not steps — the rule says so where stacked
               buttons alone would read as a sequence. The one place this page
               draws a line at all; see atoms/controls.scss on borders being rare. -->
          <p v-if="canPasskey" class="acct__or"><span>or sign in with a link</span></p>

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
                <HugeiconsIcon :icon="Key01Icon" :size="16" :stroke-width="2" />
                {{ creating ? "Waiting for your device…" : "Create account with a passkey" }}
              </button>
            </form>
            <p v-if="createNote" class="t-sm acct__note">{{ createNote }}</p>

            <p class="t-sm t-muted">
              Already have an account?
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
            <p class="t-sm t-muted">How you get back in if you lose your devices.</p>
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
              <button type="submit" class="btn btn--ghost acct__btn" :disabled="!nameDirty || nameSaving">
                {{ nameSaving ? "Saving…" : "Save" }}
              </button>
            </form>
            <p class="t-sm t-muted">
              Shown on lists you share. Leave it empty to stay anonymous.
            </p>
            <p v-if="nameNote" class="t-sm acct__note">{{ nameNote }}</p>
          </section>

          <section v-if="canPasskey" class="acct__section">
            <div class="acct__sectionhead">
              <h2 class="t-label acct__label">Passkeys</h2>
              <button type="button" class="btn btn--quiet acct__add" :disabled="pkBusy" @click="addPasskey">
                <HugeiconsIcon :icon="Key01Icon" :size="14" aria-hidden="true" :stroke-width="2" /> Add
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
              Sign in with your fingerprint or screen lock. A link always works too, so removing
              them all locks nothing.
            </p>
            <p v-if="pkNote" class="t-sm acct__note">{{ pkNote }}</p>
          </section>

          <section class="acct__section">
            <button type="button" class="btn btn--ghost acct__btn acct__signout" @click="onSignOut">Sign out</button>
            <button
              type="button"
              class="btn btn--ghost acct__btn acct__signout"
              :disabled="signingOutAll"
              @click="onSignOutEverywhere"
            >
              {{ signingOutAll ? "Signing out…" : "Sign out everywhere" }}
            </button>
          </section>

          <section class="acct__section">
            <h2 class="t-label acct__label">Delete your account</h2>
            <p class="t-sm t-muted">
              Your email, passkeys and saved gear go for good. Your lists stay — they belong
              to their edit links, and any link you’ve shared still opens them.
            </p>
            <button
              type="button"
              class="btn btn--ghost acct__btn acct__danger"
              :disabled="deleting"
              @click="deleteAccount"
            >
              {{ deleting ? "Deleting…" : "Delete account" }}
            </button>
            <p v-if="deleteNote" class="t-sm acct__note">{{ deleteNote }}</p>
          </section>
        </div>

        <p v-else class="t-muted">Loading…</p>

        <template #fallback>
          <p class="t-muted">Loading…</p>
        </template>
      </ClientOnly>
  </div>
</template>

<style scoped lang="scss">
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
/* Centred only when the signed-out column is what's below it — asked of the page's
   own structure rather than re-deriving the session state up here, so the two can't
   disagree. Signed in the page is a left-aligned stack of sections, where a centred
   heading would float free of everything under it.
   The margin drops with it: the column below sets its own top spacing, and the two
   were stacking into one very large gap. ONE spacer owns this gap, and it's this one. */
.page:has(.acct__empty) .acct__head {
  text-align: center;
  margin-bottom: var(--space-5);
}
/* CONTAINED on the signed-out screen only. The underline treatment above suits a
   field sitting in a row of other content; here the field is stacked between two
   full-width pill buttons, and a bare underline reads as a gap in that stack
   rather than a control in it. Same height, radius and padding as the buttons, so
   the three stack as one object — and the text starts on the left like any other
   input, rather than centred with the prose. */
.acct__empty .acct__input {
  width: 100%;
}
.acct__input::placeholder {
  color: var(--ink-3);
}
.acct__input:focus {
  border-color: var(--ink-2);
}

/* In the MODAL the dialog is already the measure. Both max-widths below exist to stop
   a form stranding itself in a wide page column — inside a 30rem .dlg they do nothing
   but inset the body 8px past the heading above it, which is the misalignment you see.
   The bottom padding goes the same way: .dlg has its own, and the two stacked to 56px
   under the last control against 24px above the first. */
.acct--modal .acct__body,
.acct--modal .acct__empty {
  max-width: none;
}
.acct--modal .acct__empty {
  padding-bottom: 0;
}
/* the page wants air under a page title; a dialog heading sits closer to its body */
.acct--modal .acct__head {
  margin-bottom: var(--space-4);
}

/* Signed out there is exactly one thing to do, so the column centres and narrows
   rather than sitting left in a full-width page beside empty space. */
.acct__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  max-width: 26rem;
  margin-inline: auto;
  padding-block: 0 var(--space-6);
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
  /* the house underline: soft at rest, deepens to --ink-2 — never full ink
     (tokens.scss, the --underline rule) */
  text-decoration: underline;
  text-decoration-color: var(--underline);
  text-underline-offset: 2px;
  cursor: pointer;
}
.acct__switch:hover,
.acct__switch:focus-visible {
  text-decoration-color: var(--ink-2);
}
.acct__empty .acct__alt {
  width: 100%;
  background: var(--paper-2);
  color: var(--ink-2);
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss) */
@media (hover: hover) and (pointer: fine) {
  .acct__empty .acct__alt:hover {
    background: var(--paper-3);
    color: var(--ink);
  }
}
.acct__signup {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
  width: 100%;
}
.acct__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* --space-4, not --space-5. A section's own rows sit 8px apart, and at --space-5 the
     gap around each hairline measured 49px — six times the internal spacing, which
     reads as six unrelated cards rather than one surface with parts. --space-4 puts it
     at roughly 4:1: still unmistakably a break, without the modal running to 829px and
     scrolling on a phone for content that nearly fits. */
  padding-block: var(--space-4);
}
.acct__section + .acct__section {
  border-top: 1px solid var(--line);
}
.acct__section:first-child {
  padding-top: 0;
}
/* the missing half of the rule above. The block rhythm is for the space BETWEEN
   sections; at either end the container's own padding already provides it, and in the
   dialog the two stacked to 44px under the last control against 24px above the first. */
.acct__section:last-child {
  padding-bottom: 0;
}
/* NOT the sharing panel's --text-micro field label, though both sit under a t-label
   title. Sharing's labels name an INPUT directly beneath them, so a small quiet label
   reads as attached to its control. These name a SECTION of prose — at 12px they came
   out smaller and fainter than the paragraph they introduce, which puts the heading
   below its own body text.
   The contrast this surface needs is structural rather than typographic: the sections
   are already separated by hairlines (see .acct__section), which is the work sharing
   was asking its type to do alone. */
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
/* CONTAINED, and the same container for both fields on this surface. .field is
   borderless by design — it lives in list rows, where the row's own structure says
   where the field is. Here there is no such structure, and in the modal there is even
   less: a floating panel has nothing around a control to imply its edges, so the
   container IS the affordance. (The signed-out email field already looked like this;
   the display name was a bottom rule, so the same surface had two kinds of input.) */
.acct__input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 40px;
  padding: 0 var(--space-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--paper);
  text-align: left;
}
.acct__input:focus {
  border-bottom-color: var(--ink-2);
}
.acct__row .btn {
  flex: none;
}
/* the section is a flex COLUMN, so a bare button stretches and its label centres —
   pull it back to the left edge every other line sits on */
/* The one destructive control in the app, and the one coloured one — see --danger in
   tokens.scss for why this is the single exception to monochrome chrome. It used to
   step BACK to secondary ink, on the reasoning that the confirm dialog carried the
   gravity; the trouble is that a delete button rendered quieter than the Sign out
   above it reads as the less consequential of the two, which is exactly backwards. */
/* Compound, so it beats .acct__btn's container fill — both are single-class rules and
   .acct__btn is declared after this one, so source order would otherwise win. */
.acct__btn.acct__danger {
  background: var(--danger);
  border-color: transparent;
  color: var(--danger-ink);
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss). Still
   compound inside the query, so it keeps outranking .acct__btn:hover below. */
@media (hover: hover) and (pointer: fine) {
  .acct__btn.acct__danger:hover {
    background: var(--danger);
    border-color: transparent;
    filter: brightness(1.08);
  }
}
/* CONTAINED, by the same recipe as .acct__input above — one container language for
   every control on this surface.
   It recedes to --paper with a hairline rather than sitting on a raised fill, and it
   has to: --surface-float and --paper-3 are the SAME value (#1f1f1f) in dark, so the
   .btn atom's resting/hover fill is literally invisible inside a dialog. Going darker
   than the surface is the only fill that reads here, and the hairline carries light
   mode, where --surface-float and --paper are both #fff.
   flex-start because the section is a flex column: a stretched button centres its
   label away from the line every other row starts on. */
.acct__btn {
  align-self: flex-start;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--paper);
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss) */
@media (hover: hover) and (pointer: fine) {
  .acct__btn:hover {
    /* a step TOWARD the surface, visible in both modes — see above for why the atom's
       own --paper-3 hover can't be */
    background: var(--paper-2);
    border-color: var(--line-2);
  }
}
.acct__btn:disabled {
  background: transparent;
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
