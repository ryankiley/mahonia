<script setup lang="ts">
// The account surface itself — sign-in when signed out, settings when signed in.
//
// Two mounts: the account dialog shows this over whatever you were doing, and
// /authorize sets the signed-out half inline as a step of its own card (asStep). The
// /account address opens the dialog and draws nothing of its own (pages/account.vue).
// One implementation, so the two can't drift.
//
// That last part is the whole point of the extraction. The vault went the other way
// and has two — VaultPane and /gear, ~470 lines of template between them, with a
// comment in the page admitting its prompt is copied "WORD FOR WORD" from the pane.
// Signing in and deleting an account are worse things to keep in sync by hand.
import { IconChevronDownMedium, IconClaudeai, IconCursor, IconEyeOpen, IconKey1, IconOpenai, IconPencil2, IconSquareBehindSquare1 } from "~/icons/central";
import type { AccountNotice } from "~/composables/useAccountModal";
import { normalizeEmail } from "~~/shared/email";
import { counted } from "~~/shared/tidyText";
import { SvgIcon } from "~/utils/icon";
import type { IconNode } from "~/utils/icon";
import type { AccessScope, AccessTokenSummary, PasskeySummary } from "~~/shared/types";

// Wherever it is mounted you are already where you want to be, so finishing an errand
// here (a sign-in, a sign-out) is said to the mount (`done`) and it decides: the dialog
// closes, /authorize goes on to its consent. A deleted account says nothing: the panel
// stays, as the sign-in form, under its own confirmation. The panel never navigates, and it
// draws no heading of its own: the mount titles it (v-model:heading says with what).
// It had a third mount, a page at /account with nothing behind it, which is why it once
// took a prop to say it was in a dialog, drew a page heading, centred and narrowed its
// own column, and went somewhere when it finished. That page is the dialog now (pages/account.vue).
// `asStep`: mounted as one step of another page (the /authorize consent), which has
// already said what the sign-in is for and sets its own left edge. So the why-line is
// dropped and the signed-out column reads from the left under that page's heading.
// `notice`: why the dialog was opened, when that changes what the signed-out form says
// (useAccountModal). A prop, so the panel knows nothing of the dialog it may be in.
const { asStep = false, notice = null } = defineProps<{ asStep?: boolean; notice?: AccountNotice | null }>();
const emit = defineEmits<{ done: [] }>();
// Say what this surface is FOR right now. Signed out it is a sign-in dialog, and
// titling it "Your account" describes something you don't have yet — the one thing
// the person in front of it is certain of. Signed in, it's the settings page — and
// so is a PRESUMED session (offline with the hint cookie, the body still loading):
// there is an account here, and "Sign in" over it asked for something already had.
// ONCE THE LINK IS SENT the form has done its job, and steps aside for the one thing
// left to do: go and find the mail. It stayed up before, with the address still in the
// field and Continue live again under "Check ... for a link", which read as a form still
// waiting to be filled in. The address it went to; "" while the form is what's showing.
// Up here because the heading reads it at once.
const sentTo = ref("");
const heading = computed(() =>
  presence.value !== "signedOut"
    ? "Your account"
    : sentTo.value
      ? "Check your email"
      : notice === "expired"
        ? "That link has expired"
        : notice === "failed"
          ? "Couldn’t sign you in"
          : "Sign in or sign up",
);


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
// NO useHead HERE. The dialog mount renders over some OTHER page, so a head call would
// retitle that page and, worse, stamp its own noindex onto it. A public shared list is
// one of the pages this can open over.

const { user, signedIn, presence, loaded, pending, refresh, requestLink, signOut, saveProfile, forgetAccountMemos } = useSession();
// Offline with an account, the session ask fails and stays unresolved, so neither
// branch below ever drew and this said "Loading…" for good. It says why instead; the
// session plugin asks again (useSessionReask), and its answer redraws this.
const unreachable = computed(() => presence.value === "presumed" && !pending.value);
const { confirm: askConfirm, confirmState } = useDialogs();
const pk = usePasskeys();
// whether this browser can do WebAuthn at all — resolved on mount, so the
// signed-out view offers the passkey door only where it actually opens
const canPasskey = ref(false);
onMounted(() => {
  refresh();
  canPasskey.value = passkeysSupported();
});

// ---- signed out: one door -------------------------------------------------
// ONE FORM for someone new and someone returning. It was two (Sign in, and Create an
// account behind a "New here?" switch), and the person had to know which they were. The
// link never needed telling: /api/auth/request finds the account or makes it, and gives
// the same answer either way. So it is an address and Continue, for everyone, under a
// title that names both ("Sign in or sign up": with no line under the button to say a
// first visit is welcome, the title has to). A passkey is offered from the field itself
// to someone who already added one (the account's Passkeys section is where a new
// account does that).
// The heading is handed up and never drawn here (v-model:heading): the dialog draws its
// own title and names itself by it.
const headingOut = defineModel<string>("heading");
watchEffect(() => (headingOut.value = heading.value));

// ---- signing in ----------------------------------------------------------
// A PASSKEY FROM THE EMAIL FIELD. Signed out, the browser is asked to offer any passkey
// it holds for this site in the address field's own autofill list (the field is marked
// autocomplete="... webauthn"): focus the field, pick the passkey, signed in, nothing
// typed. There is no passkey button and no link: the form is one field and Continue, and
// whoever's passkey the list can't reach (a security key, another phone, a browser with
// no such list) continues by email like everyone else, which always works.
let autofill: AbortController | null = null;
function stopAutofill() {
  autofill?.abort();
  autofill = null;
}
async function offerAutofill() {
  stopAutofill();
  const mine = (autofill = new AbortController());
  const r = await pk.signInFromAutofill(mine.signal);
  if (autofill === mine) autofill = null;
  // back to whatever you were doing: the mount closes, or goes on
  if (r === "ok") {
    tally("sign_in");
    emit("done");
  }
  // A passkey was picked and the sign-in still failed (the server refused it, or could
  // not be reached). It said nothing, and the form sat there as if nothing had been
  // tried. The address field is the way on, so the line points at it.
  else if (r === "failed") linkNote.value = "That passkey didn’t sign you in. Continue with your email instead.";
}
// OFFLINE IS KNOWN BEFORE ANYONE PRESSES. Asking for a link needs the network, and the
// browser already says when there is none, so the form says so and holds Continue
// instead of letting the press fail and then explaining. It lifts by itself when the
// connection is back. (The browser's word is only trusted this way round: it can claim
// to be online on a dead connection, and then the press fails and says why, as before.)
const online = useOnline();
// only while the signed-out form is what's showing, and gone with it; and not offline,
// where the offer cannot even be fetched
watch(
  () => loaded.value && !signedIn.value && canPasskey.value && !sentTo.value && online.value,
  (on) => (on ? void offerAutofill() : stopAutofill()),
  { immediate: true },
);
onBeforeUnmount(stopAutofill);

const linkEmail = ref("");
const linkSending = ref(false);
// WHAT WENT WRONG, in one line under the field, said aloud as it appears (role="alert").
// Each failure has its own words because each has its own remedy: fix the address,
// wait, get back online, or just try again. They were one line, "Check the address and
// try again", for failures that are never the address: the endpoint answers a
// malformed one with the same ok as a good one.
const linkNote = ref("");
const BAD_ADDRESS = "Enter a valid email address.";
/** the line is about the address itself: marks the field invalid */
const linkBadAddress = computed(() => linkNote.value === BAD_ADDRESS);
const noteId = useId();
/** counts the presses that ended in a line, so each one shows its line afresh */
const linkTry = ref(0);
// a line about what was typed is stale the moment it is retyped
watch(linkEmail, () => (linkNote.value = ""));
// FOCUS GOES WHERE THE CARD WENT. Swapping the form for the sent line removes the field
// and the button, one of which had focus, and focus then falls to <body>: the next Tab
// lands on the page behind the dialog, outside its trap, and a screen reader hears
// nothing of what replaced the form. So the sent line takes focus as it appears (it is
// read out, and Tab from it reaches the one button), and the field takes it on the way
// back.
const sentLine = useTemplateRef<HTMLElement>("sentLine");
const linkField = useTemplateRef<HTMLInputElement>("linkField");
/** The card says no to what was typed (shake-x, main.scss): for an address that isn't
 *  one, and only that. Offline or "try again" is not about what was typed, and a shake
 *  for them would send someone back to an address that was fine.
 *  THE WHOLE CARD, not the field: a hairline field swinging inside a still card read as
 *  a twitch, where the card moving as one object reads as a no. Where there is no card
 *  (a step of another page, /authorize) the field is all there is to shake.
 *  Taken off and put back across a reflow, so a second bad press shakes again. */
function shake(field: HTMLElement | null) {
  const el = field?.closest<HTMLElement>(".dlg") ?? field;
  if (!el) return;
  el.classList.remove("is-shaking");
  void el.offsetHeight;
  el.classList.add("is-shaking");
  // its own ending, not a child's: the callout inside the card ends a shorter animation
  // of its own, which bubbles here and would stop the shake a beat early
  const done = (e: AnimationEvent) => {
    if (e.target !== el) return;
    el.classList.remove("is-shaking");
    el.removeEventListener("animationend", done);
  };
  el.addEventListener("animationend", done);
}
async function useAnotherAddress() {
  sentTo.value = "";
  await nextTick();
  linkField.value?.focus();
}
async function sendLink() {
  const email = linkEmail.value.trim();
  if (!email || linkSending.value || !online.value) return;
  // The server's own rule (shared/email), asked here because the server won't say: it
  // answers `sam@gmail` with the same ok as a real address, and this form then told
  // sam to check a mailbox nothing was sent to.
  if (!normalizeEmail(email)) {
    linkTry.value++;
    shake(linkField.value);
    // the wording nearly every form uses, and an instruction rather than a remark: it
    // says what to do next
    linkNote.value = BAD_ADDRESS;
    return;
  }
  linkSending.value = true;
  linkNote.value = "";
  const r = await requestLink(email);
  linkSending.value = false;
  // The link opens in a new tab, on /auth/callback, which sends you back to the page
  // this was asked from (useReturnTo). A page this is one step of (/authorize) has
  // remembered its own request already.
  if (r === "sent" && !asStep) useReturnTo().rememberHere();
  // "sent" is the same answer for a known and an unknown address — the endpoint
  // deliberately can't tell you which, so neither can this.
  if (r === "sent") {
    sentTo.value = email;
    await nextTick();
    sentLine.value?.focus();
    return;
  }
  linkTry.value++;
  linkNote.value = {
    unavailable: "Sign-in links aren’t set up on this site yet.",
    limited: "Too many tries. Wait a minute, then try again.",
    offline: "You’re offline. Try again once you’re connected.",
    error: "Couldn’t send the link. Try again.",
  }[r];
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
    : "Couldn’t save that. Check your connection and try again.";
}

/** when a credential was last used, as the three lists on this page say it */
const usedAgo = (iso: string | null) => (iso ? `last used ${timeAgo(Date.parse(iso))}` : "not used yet");

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
  } else if (result === "failed") pkNote.value = "That didn’t work. Try again.";
  // "cancelled" is a choice, not a failure — say nothing
}

async function removePasskey(id: number) {
  if (!(await askConfirm({
    title: "Remove this passkey?",
    message: "You can still sign in with an emailed link, and add another any time.",
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

// ---- assistant access ----------------------------------------------------
// The credentials on this page that are MEANT to leave the browser, in two kinds
// (server/utils/accessTokens.ts). An app that signed in through the connector
// (Claude, from a Connect card) holds a pair it got through /authorize and is listed
// here to be disconnected. A client configured from a file (Claude Code without the
// popup, Cursor, anything with an mcp.json) is given a token minted here and sends
// that as a header instead.
//
// A minted token's value comes back from the mint and from nowhere else, ever — the
// list below is labels and dates. So it is held in `freshToken` until the next
// action on this section replaces it, and the page says, in so many words, to copy
// it now.
const tokens = ref<AccessTokenSummary[]>([]);
const tokenLabel = ref("");
const tokenScope = ref<AccessScope>("read");
const tokenBusy = ref(false);
const tokenNote = ref("");
const freshToken = ref("");
// the picker's rows; the key is the word the endpoint takes, the label is ours, and the
// marks are the share panel's for a read-only and an edit link
const SCOPES: readonly { key: AccessScope; label: string; icon: IconNode }[] = [
  { key: "read", label: "Read only", icon: IconEyeOpen },
  { key: "write", label: "Read and change", icon: IconPencil2 },
];
const scopeName = (scope: AccessScope) => SCOPES.find((s) => s.key === scope)!.label.toLowerCase();
const mcpUrl = `${useSiteOrigin()}/mcp`;
// The buttons: each client's own "install this server" link with our address filled
// in, the same ones the Help page and the README carry; ChatGPT, Gemini and the rest
// have no such link and take the address pasted in. Every one of them asks for the
// sign-in itself the first time it reaches for My Gear, so there is nothing else to
// hand over.
const addToClaude = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Mahonia&connectorUrl=${encodeURIComponent(mcpUrl)}`;
const addToCursor = `https://cursor.com/install-mcp?name=mahonia&config=${btoa(JSON.stringify({ url: mcpUrl }))}`;
// ChatGPT has no install link: its button copies the address and opens the settings
// page where a connector is made, so the paste is the only step left
const chatGptConnectors = "https://chatgpt.com/#settings/Connectors";
// The address is not on the page, so a copy that fails has to say it: "select it" would
// point at nothing.
const ADDRESS_NOT_COPIED = `Couldn’t copy. The address is ${mcpUrl}.`;
// Every copy in this section, and the line it leaves under it: the address, a fresh
// token, the command that carries one. Through the shared copyText(), awaited straight
// from the click so iOS Safari still counts it as the user's own gesture.
async function copy(text: string, done = "Copied.", failed = "Couldn’t copy. Select it and copy it by hand.") {
  tokenNote.value = (await copyText(text)) ? done : failed;
}
const copyForChatGpt = () =>
  copy(
    mcpUrl,
    "Address copied. In ChatGPT, turn on developer mode under Apps & Connectors and paste it into a new connector.",
    ADDRESS_NOT_COPIED,
  );
// the hand-minted token is the second way in, for a client that can't open a
// sign-in, and stays folded until asked for: the button above is the ordinary path
const tokenForm = ref(false);
// Claude Code is the client with a one-line install that takes the header; the
// README carries the equivalent for the others
const claudeCommand = computed(
  () => `claude mcp add --transport http --scope user mahonia ${mcpUrl} --header "Authorization: Bearer ${freshToken.value}"`,
);

async function loadTokens() {
  if (!signedIn.value) return;
  try {
    tokens.value = (await $fetch<{ tokens: AccessTokenSummary[] }>("/api/account/tokens")).tokens;
  } catch {
    // a failed read leaves the list empty and the form usable; it is not worth a note
  }
}
watch(signedIn, () => loadTokens(), { immediate: true });

async function makeToken() {
  if (tokenBusy.value) return;
  tokenBusy.value = true;
  tokenNote.value = "";
  freshToken.value = "";
  try {
    const made = await $fetch<{ ok: boolean; token?: string }>("/api/account/tokens", {
      method: "POST",
      // unnamed, a token takes the device's name, the way a new passkey does
      body: { label: tokenLabel.value.trim() || deviceLabel(), scope: tokenScope.value },
    });
    if (made.ok && made.token) {
      freshToken.value = made.token;
      tokenLabel.value = "";
      await loadTokens();
    } else {
      tokenNote.value = "That’s as many tokens as an account can hold. Revoke one to make room.";
    }
  } catch {
    tokenNote.value = "Couldn’t make a token. Check your connection and try again.";
  }
  tokenBusy.value = false;
}

// the same action for both kinds, in each one's words: a token is revoked, an app
// that signed in is disconnected and will ask again
async function revokeToken(t: AccessTokenSummary) {
  const app = t.kind === "app";
  if (!(await askConfirm({
    title: app ? `Disconnect ${t.label ?? "this app"}?` : "Revoke this token?",
    message: app
      ? "It loses access to your account and will ask you to sign in again. Your gear and lists don’t change."
      : "Whatever uses it loses access to your account. Your gear and lists don’t change.",
    confirmLabel: app ? "Disconnect" : "Revoke",
  }))) return;
  freshToken.value = "";
  tokenNote.value = "";
  try {
    await $fetch("/api/account/tokens/revoke", { method: "POST", body: { id: t.id } });
  } catch {
    tokenNote.value = app ? "Couldn’t disconnect it. Check your connection and try again." : "Couldn’t revoke it. Check your connection and try again.";
  }
  await loadTokens();
}

// ---- deleting the account ------------------------------------------------
const deleting = ref(false);
const deleteNote = ref("");

// ---- take your data with you ----
// One file: every list on this account in the shape a list's own JSON download has,
// plus My Gear in the shape its export has. Fetched rather than linked, so the
// session cookie rides the request the way every account call's does and a failure
// can say so here instead of as a browser error page; then saved the way every other
// export on the site is saved (app/utils/download).
const exporting = ref(false);
const exportNote = ref("");
async function exportEverything() {
  exporting.value = true;
  exportNote.value = "";
  try {
    const data = await $fetch<{ lists: unknown[]; gear: { items: unknown[] } }>("/api/account/export");
    downloadFile(`mahonia-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
    const n = data.lists.length;
    const g = data.gear.items.length;
    exportNote.value = `Saved ${counted(n, "list")} and ${counted(g, "piece")} of gear.`;
  } catch {
    exportNote.value = "Couldn’t build the file. Check your connection and try again.";
  } finally {
    exporting.value = false;
  }
}
// The confirmation, shown after the account is gone and the panel has flipped back to
// the sign-in screen (the dialog is still open then, as the sign-in card).
// Longer-lived than the usual toast (8s, not useToast's two): there is nothing to act
// on, and it's the only acknowledgement that an irreversible thing succeeded. Its
// markup went missing when the account became this panel (#174), and for months the
// account was deleted in silence.
const gone = ref("");
let goneTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(goneTimer));
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
        "Your email, name, passkeys, and My Gear are deleted. This can’t be undone.",
      confirmLabel: "Delete account",
      checkbox: {
        label: "Delete my lists too",
        // Says what TICKING it does. A hint that explains the unticked state reads
        // backwards under a box you're deciding whether to tick, and this is the
        // consequence people don't anticipate: the lists aren't only yours.
        hint: "Anyone you’ve sent a link to loses the list too.",
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
    forgetAccountMemos();
    // Stay here rather than navigating away. The panel re-renders as the signed-out
    // screen on its own once the session has gone, so the confirmation lands on the
    // thing that actually changed — and a toast that outlived a route change would
    // need app-wide plumbing this is the only caller for.
    await refresh(true);
    const n = res?.listsDeleted ?? 0;
    gone.value = n
      ? `Account deleted, along with ${counted(n, "list")}.`
      : "Account deleted. Your lists are untouched.";
    clearTimeout(goneTimer);
    goneTimer = setTimeout(() => (gone.value = ""), 8000);
  } catch {
    deleteNote.value = "Couldn’t delete the account. Check your connection and try again.";
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
        "Signs out every device, this one too, and disconnects every assistant. Use this if you think someone else got in.",
      confirmLabel: "Sign out everywhere",
    }))
  )
    return;
  signingOutAll.value = true;
  try {
    await $fetch("/api/auth/signout-all", { method: "POST" });
    forgetAccountMemos();
    // Stay put and re-read: there is nowhere to go, you're already looking at the
    // account.
    await refresh(true);
  } catch {
    pkNote.value = "Couldn’t sign out everywhere. Check your connection and try again.";
  }
  signingOutAll.value = false;
}

async function onSignOut() {
  await signOut(); // drops the per-account memos itself — see useSession
  // Signing out of a list you're reading shouldn't also take the list away: the dialog
  // just closes.
  emit("done");
}
</script>

<template>
  <div class="acct" :class="{ 'acct--step': asStep }">

    <ClientOnly>
      <!-- signed out there is exactly one thing to do here -->
      <div v-if="loaded && !signedIn" class="acct__empty">
        <!-- SENT: the form is gone and this is all there is (see sentTo). The address is
             said back, since a typo is the likeliest reason no mail arrives, with the way
             to fix one beside it. -->
        <template v-if="sentTo">
          <p ref="sentLine" class="t-sm t-muted acct__sent" tabindex="-1">
            We sent a sign-in link to <span class="acct__sentto">{{ sentTo }}</span>. It works once and lasts 15
            minutes.
          </p>
          <!-- contained, in the grey of a second button: it stands where Continue stood, and
               a bare underlined line there read as a footnote, not the way back -->
          <button type="button" class="btn btn--soft acct__again" @click="useAnotherAddress">
            Use a different address
          </button>
        </template>
        <template v-else>
          <!-- the one line that says what an account is FOR, before it asks for one: your
               gear is the whole reason, and a stranger who tapped the person icon has not
               been told. Lists never needing it is the half that keeps the promise. -->
          <p v-if="notice === 'expired'" class="t-sm t-muted acct__why">
            Sign-in links work once and last 15 minutes. Enter your email for a new one.
          </p>
          <p v-else-if="notice === 'failed'" class="t-sm t-muted acct__why">
            That link isn’t working. Enter your email for a new one.
          </p>
          <p v-else-if="!asStep" class="t-sm t-muted acct__why">
            An account saves your gear across lists and devices. Lists work without one.
          </p>

          <!-- THE DOOR: an address and one button, the same for a first visit and a
               return (see the script). The primary, wherever it is drawn. -->
          <!-- novalidate: the browser's own bubble for a bad address is a second voice,
               in the system's type and a different place in every browser. The line under
               the field says it instead (sendLink). -->
          <form class="acct__signup" novalidate @submit.prevent="sendLink">
            <input
              ref="linkField"
              v-model="linkEmail"
              class="field acct__input"
              type="email"
              autocomplete="username webauthn"
              placeholder="you@example.com"
              aria-label="Email address"
              :aria-invalid="linkBadAddress || undefined"
              :aria-describedby="linkNote || !online ? noteId : undefined"
            />
            <!-- under the field it is about and pointing at it, above the button that tries
                 again (.errtip, controls.scss). Keyed by the try: a second failed press
                 re-makes it, so it arrives again and is read out again, where the same
                 line sitting still looked like a press that did nothing. -->
            <p v-if="!online" :id="noteId" class="errtip errtip--note" role="status">
              You’re offline. Connect to sign in.
            </p>
            <p v-else-if="linkNote" :id="noteId" :key="linkTry" class="errtip" role="alert">{{ linkNote }}</p>
            <button type="submit" class="btn btn--primary" :disabled="linkSending || !linkEmail.trim() || !online">
              {{ linkSending ? "Sending…" : "Continue" }}
            </button>
          </form>

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
                <SvgIcon :icon="IconKey1" size="sm" aria-hidden="true" /> Add
              </button>
            </div>
            <ul v-if="passkeys.length" class="acct__list">
              <li v-for="k in passkeys" :key="k.id" class="acct__item">
                <span class="acct__name">{{ k.label || "Passkey" }}</span>
                <span class="t-sm t-muted acct__meta">{{ usedAgo(k.lastUsedAt) }}</span>
                <button type="button" class="btn btn--quiet" @click="removePasskey(k.id)">Remove</button>
              </li>
            </ul>
            <p class="t-sm t-muted">
              Sign in with your fingerprint or screen lock. An emailed link always works too, so
              it’s safe to remove them all.
            </p>
            <p v-if="pkNote" class="t-sm acct__note">{{ pkNote }}</p>
          </section>

          <!-- ASSISTANT ACCESS: the connector. Below the passkeys because what it leaves
               behind is the same kind of thing, a credential you review and revoke here. -->
          <section class="acct__section">
            <h2 class="t-label acct__label">Assistant access</h2>
            <!-- each client's own mark on its button; Cursor's is the cube its logo is drawn as -->
            <div class="acct__clients">
              <a :href="addToClaude" target="_blank" rel="noopener noreferrer" class="btn btn--primary">
                <SvgIcon :icon="IconClaudeai" aria-hidden="true" /> Add to Claude
              </a>
              <!-- the copy runs inside the click, before the link opens the settings page -->
              <a :href="chatGptConnectors" target="_blank" rel="noopener noreferrer" class="btn btn--ghost acct__btn" @click="copyForChatGpt">
                <SvgIcon :icon="IconOpenai" aria-hidden="true" /> ChatGPT
              </a>
              <a :href="addToCursor" target="_blank" rel="noopener noreferrer" class="btn btn--ghost acct__btn">
                <SvgIcon :icon="IconCursor" aria-hidden="true" /> Cursor
              </a>
              <button type="button" class="btn btn--ghost acct__btn" @click="copy(mcpUrl, 'Address copied.', ADDRESS_NOT_COPIED)">
                <SvgIcon :icon="IconSquareBehindSquare1" aria-hidden="true" /> Copy address
              </button>
            </div>
            <p class="t-sm t-muted">Any other MCP client takes the address. Each one asks you to sign in here the first time.</p>
            <ul v-if="tokens.length" class="acct__list">
              <li v-for="t in tokens" :key="t.id" class="acct__item">
                <span class="acct__name">{{ t.label || "Token" }}</span>
                <span class="t-sm t-muted acct__meta">
                  {{ t.kind === "app" ? "signed in" : "token" }} · {{ scopeName(t.scope) }} · {{ usedAgo(t.lastUsedAt) }}
                </span>
                <button type="button" class="btn btn--quiet" @click="revokeToken(t)">{{ t.kind === "app" ? "Disconnect" : "Revoke" }}</button>
              </li>
            </ul>
            <p v-if="!tokenForm" class="t-sm t-muted">
              Using a client that can’t sign in?
              <button type="button" class="acct__switch" @click="tokenForm = true">Make a token</button>
            </p>
            <form v-else class="acct__row acct__tokenrow" @submit.prevent="makeToken">
              <input
                v-model="tokenLabel"
                class="field acct__input"
                type="text"
                maxlength="60"
                placeholder="Name it, e.g. Claude Code"
                aria-label="Token name"
              />
              <!-- the app's own picker rather than a native select — OptionMenu says why -->
              <OptionMenu
                :options="SCOPES"
                :current="tokenScope"
                label="What the token can do"
                trigger-class="btn btn--ghost acct__btn acct__scope"
                @pick="(k) => (tokenScope = k as AccessScope)"
              >
                <template #trigger="{ active, open }">
                  <span>{{ active?.label }}</span>
                  <SvgIcon :icon="IconChevronDownMedium" class="chev" :class="{ 'is-open': open }" size="sm" aria-hidden="true" />
                </template>
              </OptionMenu>
              <button type="submit" class="btn btn--ghost acct__btn" :disabled="tokenBusy">
                {{ tokenBusy ? "Making…" : "Make token" }}
              </button>
            </form>
            <div v-if="tokenForm && freshToken" class="acct__fresh">
              <p class="t-sm acct__note">Shown once. Copy it before you leave this page.</p>
              <code class="acct__secret">{{ freshToken }}</code>
              <p class="t-sm t-muted">For Claude Code, this one line adds the connector with the token:</p>
              <code class="acct__secret">{{ claudeCommand }}</code>
              <div class="acct__copies">
                <button type="button" class="btn btn--ghost acct__btn" @click="copy(freshToken)">Copy token</button>
                <button type="button" class="btn btn--ghost acct__btn" @click="copy(claudeCommand)">Copy command</button>
              </div>
            </div>
            <p v-if="tokenNote" class="t-sm acct__note">{{ tokenNote }}</p>
          </section>

          <section class="acct__section">
            <h2 class="t-label acct__label">Take your data with you</h2>
            <p class="t-sm t-muted">
              One file with every list on this account, plus My Gear. Import can restore any list in
              it.
            </p>
            <button type="button" class="btn btn--ghost acct__btn" :disabled="exporting" @click="exportEverything">
              {{ exporting ? "Building the file…" : "Download everything" }}
            </button>
            <p v-if="exportNote" class="t-sm acct__note">{{ exportNote }}</p>
          </section>

          <!-- Signing out, at the end with the account's other way out (delete, below):
               it sat mid-dialog between two settings, as if it were one. One row, the
               everyday action first. -->
          <section class="acct__section acct__signouts">
            <button type="button" class="btn btn--ghost acct__btn" @click="onSignOut">Sign out</button>
            <button
              type="button"
              class="btn btn--ghost acct__btn"
              :disabled="signingOutAll"
              @click="onSignOutEverywhere"
            >
              {{ signingOutAll ? "Signing out…" : "Sign out everywhere" }}
            </button>
          </section>

          <section class="acct__section">
            <h2 class="t-label acct__label">Delete your account</h2>
            <p class="t-sm t-muted">
              Your email, passkeys, and My Gear are deleted for good. Your lists and their links
              keep working unless you choose to delete them too.
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

        <p v-else-if="unreachable" class="t-muted">You’re offline. Your account opens once you’re back online.</p>
        <p v-else class="t-muted">Loading…</p>

        <template #fallback>
          <p class="t-muted">Loading…</p>
        </template>
      </ClientOnly>

    <!-- "Account deleted", over the sign-in screen the deletion lands on: the app's own
         toast (atoms/controls.scss), the pill the read views' menu confirms a copy
         with, drawn here in place. The status region is ALWAYS here and only its words come and
         go: a live region that arrives already holding its text is one a screen reader
         may not announce. Empty, it is a block of no height. -->
    <div role="status">
      <Transition name="toast">
        <div v-if="gone" class="toast t-sm">{{ gone }}</div>
      </Transition>
    </div>
  </div>
</template>

<style scoped lang="scss">
.acct__body {
  display: flex;
  flex-direction: column;
}
.acct__input:focus {
  border-color: var(--foreground-secondary);
}

/* the address in the sent line, in primary foreground and unbroken where it fits */
.acct__sentto {
  color: var(--foreground-primary);
  overflow-wrap: anywhere;
}
/* The sent state keeps the form's two distances: the line stands one group off the
   button under it, as the explanation does off the field (.acct__why), and the button
   runs the column's width, as Continue did. */
.acct__sent {
  margin-block-end: var(--space-2);
}
/* it takes focus to be read out and to keep Tab inside the card (sendLink), not to be
   shown as a control: there is nothing here to press */
.acct__sent:focus {
  outline: none;
}

/* THE SIGNED-OUT COLUMN. Its mount is the measure (the sign-in card, or /authorize's
   own column), so it sets no width and no padding of its own: the controls run the
   mount's width and the lines sit between them.
   In the dialog it is the sign-in card (SignInHead.vue): the title is
   centred under the mark, so the lines under it are centred too, and balanced like the
   card's other centred copy. */
.acct__empty {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-4);
  text-align: center;
  text-wrap: balance;
}
/* TWO DISTANCES in this column, and no third. Things that are one group sit --space-3
   apart (a field and its button; in the dialog, the title and the line under it), and
   the groups sit --space-5 apart: the explanation, the form, and then the card's own
   padding below it, which is --space-5 as well. It ran 22 / 28 / 12 / 16 / 24 down the
   dialog, so the explanation stood further from the field than from its own title.
   The column's gap is --space-4, so the explanation adds the --space-2 that makes its
   edge --space-5. */
.acct__why {
  margin-block-end: var(--space-2);
}
/* A STEP OF ANOTHER PAGE reads from the left, under that page's own left edge: a
   centred column there put a centred paragraph under a left-aligned heading. It also
   takes back the --space-2 the host's heading stands off it, so the heading and the
   first line are one group's distance apart. */
.acct--step .acct__empty {
  text-align: start;
  text-wrap: pretty;
  margin-block-start: calc(-1 * var(--space-2));
}
/* a step of another page reads from the left, so its error does too: at the field's
   leading edge, the point a little way in */
.acct--step .errtip {
  align-self: flex-start;
  --errtip-at: var(--space-5);
}
/* A button that reads as a link: it acts in place (opens the token form) rather than
   going anywhere, so it is not an anchor (the reset already strips a button's chrome,
   so only the link's own look is said here). */
.acct__switch {
  color: var(--foreground-primary);
  font-weight: var(--font-weight-semibold);
  /* the house underline: soft at rest, deepens to --foreground-secondary — never primary
     foreground (tokens.scss, the --underline rule) */
  text-decoration: underline;
  text-decoration-color: var(--underline);
  text-underline-offset: var(--underline-offset);
}
.acct__switch:focus-visible {
  text-decoration-color: var(--foreground-secondary);
}
/* pointer-gated, foreground included: a tap latches :hover on touch, and the underline would
   stay deepened on a switch nobody is pointing at */
@media (hover: hover) and (pointer: fine) {
  .acct__switch:hover {
    text-decoration-color: var(--foreground-secondary);
  }
}
.acct__signup {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
/* one rhythm for every block: a hairline above, the same padding below it. The
   sections differ in content, never in spacing. */
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
  border-top: 1px solid var(--border-primary);
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
/* NOT a 12px --text-micro label: a small quiet label reads as attached to an input
   directly beneath it, and these name a SECTION of prose. At 12px they came out
   smaller and fainter than the paragraph they introduce, which puts the heading below
   its own body text. The contrast this surface needs is structural rather than
   typographic: the sections are already separated by hairlines (see .acct__section). */
.acct__label {
  color: var(--foreground-secondary);
}
.acct__value {
  color: var(--foreground-primary);
}
.acct__sectionhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.acct__add {
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
   the display name was a bottom rule, so the same surface had two kinds of input.)
   On the signed-out screen the field sits over a full-width pill button, where a bare
   underline reads as a gap rather than a control: the same height, radius and padding
   as the button, so the two stack as one object, and the text starts on the left like
   any other input, rather than centred with the prose. Its full width and placeholder
   foreground are .field's (controls.scss). */
.acct__input {
  flex: 1 1 auto;
  min-height: var(--control-h);
  padding: 0 var(--space-4);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-pill);
  background: var(--background-primary);
  text-align: left;
}
.acct__row .btn {
  flex: none;
}
/* the section is a flex COLUMN, so a bare button stretches and its label centres —
   pull it back to the left edge every other line sits on */
/* The one destructive control in the app, and the one coloured one — see --danger in
   tokens.scss for why this is the single exception to monochrome chrome. It used to
   step BACK to secondary foreground, on the reasoning that the confirm dialog carried the
   gravity; the trouble is that a delete button rendered quieter than the Sign out
   above it reads as the less consequential of the two, which is exactly backwards. */
/* Compound, so it beats .acct__btn's container fill — both are single-class rules and
   .acct__btn is declared after this one, so source order would otherwise win. */
.acct__btn.acct__danger {
  background: var(--danger);
  border-color: transparent;
  color: var(--danger-foreground);
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
   It recedes to --background-primary with a hairline rather than sitting on a raised
   fill, and it has to: --surface-1 and --background-tertiary are the SAME value (#1f1f1f)
   in dark, so the .btn atom's resting/hover fill is literally invisible inside a dialog.
   Going darker than the surface is the only fill that reads here, and the hairline
   carries light mode, where --surface-1 and --background-primary are both #fff.
   flex-start because the section is a flex column: a stretched button centres its
   label away from the line every other row starts on. The pill corner is .btn's own. */
.acct__btn {
  align-self: flex-start;
  border: 1px solid var(--border-primary);
  background: var(--background-primary);
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss) */
@media (hover: hover) and (pointer: fine) {
  .acct__btn:hover {
    /* a step TOWARD the surface, visible in both modes — see above for why the atom's
       own --background-tertiary hover can't be */
    background: var(--background-secondary);
    border-color: var(--border-strong);
  }
}
.acct__btn:disabled {
  background: transparent;
}
.acct__note {
  color: var(--foreground-primary);
}
.acct__list {
  display: flex;
  flex-direction: column;
}
/* A credential row: its name and its button on the first line, the facts about it
   (how it signed in, what it can do, when it was last used) on a line of their own
   beneath. One line held all three once, and at 320px or in the 26rem modal the
   three-way squeeze broke "Claude" mid-word and pushed "Disconnect" out of its own
   button (reset.scss lets every flex child shrink below its content). The facts run
   to about fifty characters; given the row's whole width they take a line or two,
   where wedged between a name and a button they took three or more.
   The button's track is max-content, the grid's flex: none: it is never narrower than
   its label. The name's track takes the rest, and a name too long for it (a token
   label runs to 60 characters) wraps rather than clips, since it is the thing that
   says which credential you are about to revoke. */
.acct__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: baseline;
  column-gap: var(--space-3);
  row-gap: var(--space-px);
  padding-block: var(--space-3);
}
.acct__item + .acct__item {
  border-top: 1px solid var(--border-primary);
}
.acct__name {
  overflow-wrap: anywhere;
}
.acct__item > .btn {
  grid-column: 2;
  grid-row: 1;
}
.acct__meta {
  grid-column: 1 / -1;
  grid-row: 2;
}
/* Three controls in this row where the others carry two, so it is allowed to wrap.
   At phone width the name field takes a line of its own (the 12rem basis is what
   tips it over) and the picker and the button share the next, which beats three
   pills each cut to an ellipsis on one line. */
.acct__tokenrow {
  flex-wrap: wrap;
}
.acct__tokenrow .acct__input {
  flex: 1 1 12rem;
}
/* The picker's trigger, as the bordered pill the field and the button beside it are.
   Its classes arrive through triggerClass, so the global .btn and .btn--ghost land on
   it, but nothing scoped here did: the trigger is OptionMenu's own inner button, not its
   root, and that component's bare-trigger rule (no padding, inherited foreground) outranks
   .btn. It drew as a bare word between two pills. So the row's recipe is carried across
   by hand: .btn's inline padding and .btn--ghost's foreground put back, and .acct__btn's
   hairline, ground and hover, which "Make token" takes from that class. And its longer
   label never breaks inside the pill. */
.acct__tokenrow :deep(.acct__scope) {
  padding: 0 var(--space-4);
  border: 1px solid var(--border-primary);
  background: var(--background-primary);
  color: var(--foreground-secondary);
  white-space: nowrap;
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss) */
@media (hover: hover) and (pointer: fine) {
  .acct__tokenrow :deep(.acct__scope:hover) {
    background: var(--background-secondary);
    border-color: var(--border-strong);
    color: var(--foreground-primary);
  }
}
.acct__fresh {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* The token, and the command that carries it: shown in full, selected whole with
   one tap (user-select: all), and allowed to break at any character so a 50-character
   secret cannot widen the column at phone width. The chrome size, not the body's:
   it is a value to copy, not a sentence to read. */
.acct__secret {
  display: block;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-2);
  background: var(--background-primary);
  font-size: var(--text-chrome);
  overflow-wrap: anywhere;
  user-select: all;
}
/* the copy buttons under a fresh token, and the client buttons: one wrapping row each.
   The clients take the row gap every other row on this surface keeps, and the .btn
   atom's own icon-to-label gap, so a pill with a mark reads like the sign-in's. */
.acct__copies,
.acct__clients {
  display: flex;
  flex-wrap: wrap;
  /* --space-2, a section's own row gap: at --space-3 the four pills read as loose */
  gap: var(--space-2);
}
/* the two ways to sign out, side by side, wrapping on a narrow phone */
.acct__signouts {
  flex-direction: row;
  flex-wrap: wrap;
}
</style>
