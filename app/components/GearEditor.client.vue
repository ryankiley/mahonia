<script setup lang="ts">
import { HugeiconsIcon, type IconNode } from "~/utils/hugeicon";
// The ⋯ menu's own glyphs are NOT here — they ride its lazy chunk (EditorMenu);
// the toolbar keeps only the one that opens it.
import { Backpack03Icon, CheckmarkSquare02Icon, EllipsisIcon, Route02Icon, SafeBoxIcon, Share08Icon, UndoIcon } from "@hugeicons/core-free-icons";
import { editLinkPath, normalizeShareCode } from "~~/shared/links";
import { forgetClaimedOpen } from "~/composables/useClaimedLists";
import { resumeHere } from "~/composables/useResumed";
import type { Item } from "~~/shared/types";
import type { EditorMode } from "~/composables/useEditorMode";
import { CHILDREN_BY_PARENT, PEOPLE_CTX, VARIANT_SHOWN } from "~/components/ItemRow.vue";
import { useGearEditorView } from "~/composables/useGearEditorView";

// The whole editor surface (its own sticky topbar + flex shell). Rendered by
// the page routes: /e (bare, prerendered) and /e/[code]
// (client-only under a server-rendered <head>). It is CLIENT-ONLY — it holds a
// singleton controller with IndexedDB + window listeners, so it never runs on the
// server (the .client.vue suffix keeps it out of both pages' SSR/prerender pass).

const c = useGearList();
const router = useRouter();
const my = useMyLists();
const session = useSession();
// app-wide dialogs (replace native confirm()/the copy dead-end) — see useDialogs
const { confirm: askConfirm, showLinkFallback } = useDialogs();
const { toast, flash } = useToast();

const snapshot = c.snapshot;
const totals = c.totals;
const status = c.status;
const pendingUndo = c.pendingUndo;
const vaultPrompt = c.vaultPrompt;
const vaultPicker = c.vaultPicker;
// The chooser is a Lazy component, but rendering it unconditionally (it opens itself
// off `caps`) fetched its chunk and stylesheet on every editor mount all the same —
// two requests for a dialog most lists never show. Mounted on the first answer that
// opens it, and kept after, like the other lazy dialogs below.
const vaultPickerEverOpened = ref(false);
watch(vaultPicker, (caps) => {
  if (caps) vaultPickerEverOpened.value = true;
});
// whether the open list is a CLAIMED one (session + share code, no edit token on
// this device) — the reactive flag the chrome gates on, since c.editToken is a
// plain getter nothing can track
const openedByCode = c.openedByCode;
const keylessCode = c.keylessCode;

// First-run / returning-user helper: an untouched draft (not yet saved to the
// server, no named item — the starter draft ships one blank row) shows a one-line
// intro so the bare-domain landing isn't a nameless editor, plus a pointer back to
// saved lists for anyone who has them (the editor otherwise only reaches "Your
// lists" via the footer). shareCode/items are reactive, so it recedes the moment
// the first real item lands (which is also when the draft gets its shareCode).
const savedCount = computed(() => my.entries.value.length);
const isFirstRun = computed(() => {
  const s = snapshot.value;
  if (!s || s.shareCode) return false;
  return !s.items.some((i) => i.name.trim());
});
// Dismissal STICKS across drafts: this is a signpost for someone who already knows
// where their lists are, so re-offering it on every new list is the nagging the
// close button is there to stop. The editor is client-only, so localStorage is safe
// to read at setup without an SSR mismatch.
const INTRO_DISMISSED_KEY = "gear.intro.dismissed.v1";
const introDismissed = ref(localStorage.getItem(INTRO_DISMISSED_KEY) === "1");
function dismissIntro() {
  introDismissed.value = true;
  resumed.value = null;
  remember(INTRO_DISMISSED_KEY, "1");
}
// The bare address resumes the list you opened last (app/pages/index.vue); the first
// time it does, the same signpost points at the switcher with the other reading —
// you are ON a list now, and the rest are behind the chip. Same sticky dismissal.
const resumed = useResumed();
const resumedHere = computed(() => !!resumed.value && snapshot.value?.shareCode === resumed.value);
const showIntro = computed(
  () =>
    (resumedHere.value || (isFirstRun.value && savedCount.value > 0)) &&
    !introDismissed.value &&
    !vaultOpen.value,
);

// Reflect the list's given name in the tab title AND the page's social/preview
// metadata, matching the read views (/l, /s): a named list carries its name; an
// unnamed draft (the bare-domain landing) keeps the generic site card, so the
// static nuxt.config card that unfurls the bare domain is unchanged.
//
// This runs client-side, so it drives the browser tab + in-app share targets. The
// SERVER-rendered name that JS-less unfurl bots (Apple Notes/iMessage/Slack) read
// comes from the /e/[code] route's <head> — that's why the shareable edit link
// embeds the share code in its path.
// naming rule + description builder shared with the /e/[code] SSR head via
// editorSeo (app/utils/editorSeo.ts), so the two surfaces can't drift
const seo = computed(() =>
  editorSeo(snapshot.value?.title, totals.value, snapshot.value?.displayUnit),
);
useHead({
  title: () =>
    !snapshot.value
      ? "Mahonia"
      : seo.value.name
        ? `${seo.value.name} — Mahonia`
        : "Untitled list — Mahonia",
});
useSeoMeta({
  description: () => seo.value.desc,
  ogTitle: () => seo.value.name || GENERIC_TITLE,
  ogDescription: () => seo.value.desc,
});
const {
  anyPacked,
  childrenByParent,
  chipWeights,
  clearChecks,
  emptyFilterName,
  everPlan,
  filterCaption,
  hasUnassigned,
  headline,
  itemsByFolder,
  mode,
  modeSwitching,
  packed,
  packProgress,
  people,
  peopleOpen,
  personFilter: pf,
  personFilterAttr,
  personSlotById,
  sortedFolders,
  ungrouped,
  variantShown,
  view,
} = useGearEditorView({ flash, askConfirm });
provide(CHILDREN_BY_PARENT, childrenByParent);
provide(PEOPLE_CTX, { sorted: people, slotById: personSlotById });
provide(VARIANT_SHOWN, variantShown);
const NO_ITEMS: Item[] = [];

/**
 * The three views, named the way a person would say them.
 *
 * WORDS, where these used to be three icons with tooltips. A tooltip is not an answer on
 * a phone — <Tooltip> declines to open where there is no hover — so the marks had to be
 * learned by pressing them. The icons stay as the leading glyph, which is what makes the
 * pair recognisable at a glance once the word has been read once.
 *
 * MODE_ORDER stays the source of truth for what a stored value may be; this array is what
 * the control renders, in the same order, so the sliding indicator's index matches.
 */
// "GEAR", not "Editing". Editing names the mechanic — what the controls let you do —
// where the other two name the job: packing the bag, planning the walk. This mode's job is
// deciding what to bring, and the thing you are looking at while you do it is the gear.
//
// It also settles the vocabulary across surfaces: the read-only view's own switcher
// already says Gear / Trip, so one word now means one thing wherever it appears. The cost
// is that it is a noun beside two gerunds, which was the trade taken deliberately —
// matching the read view beats matching the suffix.
const MODES = [
  { key: "edit", label: "Gear", icon: Backpack03Icon },
  { key: "pack", label: "Packing", icon: CheckmarkSquare02Icon },
  { key: "plan", label: "Trip", icon: Route02Icon },
] as const satisfies readonly { key: EditorMode; label: string; icon: IconNode }[];

// The vault palette. Closed by default and only ever opened deliberately, so the
// pane's chunk (and the vault read behind it) costs nothing until it's wanted.
const vaultOpen = ref(false);
// Split-pane width, remembered: how much of the screen you're willing to give the
// vault is a working preference, not a per-session one. The pane clamps the value
// it writes back, so a hand-edited or stale figure can't wedge the panel off-screen.
const VAULT_W_KEY = "gear.vault.width.v1";
const vaultWidth = ref(clampVaultWidth(Number(localStorage.getItem(VAULT_W_KEY))));
watch(vaultWidth, (w) => remember(VAULT_W_KEY, String(w)));
// The width lands on the editor root as an inherited custom property — but written
// imperatively, NOT as a template :style binding: only CSS consumes this value, and a
// binding made every change re-render this whole component for a style write. During a
// divider drag VaultPane writes the SAME property on the same element per frame (see
// startResize there) and commits the ref once on release, so a resize renders nothing.
const editorRef = ref<HTMLElement | null>(null);
watchPostEffect(() => {
  editorRef.value?.style.setProperty("--vault-w", `${vaultWidth.value}px`);
});
// The undo toast holds its dismiss timer while hovered or containing focus, and
// restarts the window on leave/blur. Two flags (pointer, focus) so releasing one
// while the other still holds doesn't resume the clock. They reset when the toast
// goes, since no mouseleave/focusout fires for an element that just unmounted —
// otherwise a stale "hovered" would pin the NEXT toast open forever.
const undoHovered = ref(false);
const undoFocused = ref(false);
watch(
  () => undoHovered.value || undoFocused.value,
  (held) => (held ? c.holdUndo() : c.releaseUndo()),
);
watch(pendingUndo, (u) => {
  if (!u) {
    undoHovered.value = false;
    undoFocused.value = false;
  }
});
const importOpen = ref(false);
const menuOpen = ref(false);
// The menu's body is a Lazy component (EditorMenu) behind the same everOpened guard
// the dialogs use: its rows, glyphs and export section are fetched and mounted on
// the first open, so a visit that never opens ⋯ downloads none of it. The trigger,
// the dismiss contract and `menuOpen` stay here.
//
// `warmMenu` flips the guard a beat EARLY — on the pointer reaching the button, or
// focus landing on it — so the chunk is fetched and the component mounted (closed)
// before the click, and the click only has to open it. An async component resolves
// its chunk first and mounts after, so on a cold visit the first open would
// otherwise paint nothing for one round trip and ease in only then; the hover is
// where that round trip hides. Touch has no hover, and gets what it always got.
const menuEverOpened = ref(false);
function warmMenu() {
  menuEverOpened.value = true;
}
const menuRef = useTemplateRef<HTMLElement>("menuRef");
// the import's one-line note ("18 of 25 rows matched the catalog."), shown once the list
// it made is on screen — keyed on the share code, because the page may or may not
// remount on the way here (/e → /e/{code} does; /e/{a} → /e/{b} doesn't)
const importNote = useImportNote();
watch(
  () => snapshot.value?.shareCode,
  (code) => {
    if (!code || !importNote.value) return;
    flash(importNote.value);
    importNote.value = null;
  },
  { immediate: true },
);

// "Add folder" becomes an inline text field on tap; it only creates the folder
// (and shows the next "Add folder") once you commit — enter or click away.
const addingFolder = ref(false);
const newFolderRef = useTemplateRef<HTMLInputElement>("newFolderRef");
function openAddFolder() {
  addingFolder.value = true;
  nextTick(() => newFolderRef.value?.focus());
}
function commitAddFolder() {
  const name = newFolderRef.value?.value.trim();
  if (name) c.addFolder(name);
  addingFolder.value = false;
}

const route = useRoute();
// A resume that lands on a DEAD list is not an error page's business. The bare address
// picks this browser's most recently opened list without asking the server whether
// its token still works (shared/switcher resumeTarget), so a list deleted or rotated
// on another device would have greeted you with "can't be opened anymore" instead of
// your list. Drop the dead entry and go where the bare address would have gone
// without it: the next list this browser holds, or a fresh draft. Only for a resume:
// a dead link you opened yourself still gets the message, which is the honest answer
// to that link.
//
// Either shape of entry can go dead, and each is dropped where it lives: a token in
// the registry, a claimed open in the opens ledger. Two things "missing" can ALSO
// mean are not that, and neither may forget anything. A keyless start — the route
// watcher never asked, because the session hint was gone — says nothing about the
// list: openedByCode tells it apart, since a claimed load() leaves it set through
// its own failure and startKeyless clears it. And a 404 that arrives after edits
// have been made here is a flush's, minutes into the session, not the resume's:
// forgetting the token then deleted the on-device record holding the very ops that
// had just failed to land. The next hop leaves this code out of the ranking outright
// (resumeHere's `except`), so it can never be the address just found dead — the
// storage write behind forgetClaimedOpen can be refused, and a bounce to the route
// already on screen is no bounce at all.
let editedHere = false;
watch(status, (s) => {
  if (s === "loading") editedHere = false; // a new session starts clean
  if (s === "saving") editedHere = true;
  if (s !== "missing" || !resumed.value || editedHere) return;
  const code = normalizeShareCode(typeof route.params.code === "string" ? route.params.code : "");
  if (!code || code !== resumed.value) return;
  const token = decodeURIComponent(route.hash.replace(/^#/, ""));
  if (token) my.forget(token);
  else if (openedByCode.value) forgetClaimedOpen(code);
  const next = resumeHere(code);
  resumed.value = next?.shareCode ?? null;
  navigateTo(next?.to ?? "/e", { replace: true });
});
// The epoch of the session THIS instance started. On an /e ↔ /e/[code] route
// swap, Nuxt runs the incoming page's setup (whose watcher below starts a new
// session) BEFORE this instance unmounts — passing our own epoch lets dispose()
// no-op when the session is no longer ours, instead of tearing down the newer
// instance's in-flight load (which stranded the editor on "Loading…").
let ownedEpoch: number | undefined;
// Tear down whatever session this instance owns and start the one `cap` names (or a
// fresh draft when it names none), re-capturing the epoch. The ordering is the whole
// point — see the note above — so it lives in ONE place, called by the route watcher
// and by newList's in-place reset alike.
function startSession(cap?: { token?: string; code?: string }) {
  c.dispose(ownedEpoch);
  if (cap?.token || cap?.code) c.load(cap);
  else c.startDraft();
  ownedEpoch = c.epoch; // load()/startDraft() mint their epoch synchronously
}
// Drive load off the reactive hash so back/forward + same-route nav between two
// of your lists dispose+reload correctly (the editor singleton holds one list).
// The route's CODE param joins the source: a claimed list opened from the switcher
// is /e/{code} with no fragment at all, so switching between two claimed lists
// moves only the param.
watch(
  () => [route.hash, route.params.code] as const,
  ([h, codeParam]) => {
    // decode HERE, not inside startSession: a malformed hash ("#%") throws, and that
    // throw must land before the dispose, exactly as it always has.
    // first run: ownedEpoch is undefined → dispose is unconditional, clearing (and
    // flushing) whatever session a previous page instance left behind
    const token = decodeURIComponent((h || "").replace(/^#/, ""));
    if (token) return startSession({ token });
    // No token, but a code in the path: a claimed list — IF a session plausibly
    // exists (the hint cookie; the fetch itself is what proves it). For everyone
    // else /e/{code} without a fragment is a truncated link, handled below without
    // a doomed request per visit.
    // Normalized HERE as well as in load(): a path segment that can't be a share
    // code at all (/e/garbage) falls through to the draft for the signed-in too,
    // instead of spending a request to be told 401.
    const code = normalizeShareCode(typeof codeParam === "string" ? codeParam : "");
    if (code && session.hasSessionHint()) return startSession({ code });
    // A well-formed code, no key, no session: a truncated edit link. Say so, and
    // offer the read-only view the same code opens, rather than landing a fresh
    // draft under the dead address (which read as "the list is empty"). No request
    // is made: nothing could succeed without a key or a session.
    // ...unless this browser holds the key itself. A list made or opened here is in
    // the registry with its token, so a truncated link to your OWN list opens it for
    // editing (the fragment is restored and this watcher runs again) rather than
    // offering you the read-only view of it.
    const mine = code ? my.entries.value.find((e) => e.shareCode === code)?.editToken : undefined;
    if (mine) return navigateTo({ path: route.path, hash: `#${mine}` }, { replace: true });
    if (code) {
      c.dispose(ownedEpoch);
      c.startKeyless(code);
      ownedEpoch = c.epoch;
      return;
    }
    startSession(); // a fresh, unsaved draft (persists on first real content)
  },
  { immediate: true },
);
// the toast clears its own timer (useToast)
onBeforeUnmount(() => c.dispose(ownedEpoch));

// On touch, the browser's own "scroll the focused field into view" is flaky — it
// sometimes no-ops, leaving the field sitting under the keyboard. Force it: once
// the keyboard has had time to animate up, bring the field into the space that's
// left. Skips the sticky-header fields, which are always visible anyway.
//
// It runs on EVERY pointer type now, and it has to: ItemInput focuses a new row with
// preventScroll, so the browser no longer reveals a focused field on any device and
// this is the only thing left that can. The old coarse gate was written when this
// centred the field — a big unasked-for jump, correctly kept off desktop — but it
// moves the minimum now, which is precisely what the browser used to do here anyway.
// Without the gate, holding Enter to add a run of rows keeps each new field on screen
// on a laptop, which is the case the gate would now break.
//
// The DELAY is what stays keyboard-specific: 300ms buys the keyboard time to finish
// rising so `visualViewport.height` is the real remaining space. There is no keyboard
// on a fine pointer and nothing to wait for, so it acts on the next tick instead —
// a 300ms lag on a desktop Enter would read as the page drifting on its own.
/** Breathing room between a rescued field and the edge it was hiding behind — enough
 *  that the field reads as "on screen" rather than "just barely on screen". */
const FOCUS_MARGIN = 12;
let focusScrollTimer: ReturnType<typeof setTimeout> | undefined;
function onFocusIn(ev: FocusEvent) {
  const el = ev.target as HTMLElement | null;
  if (!el?.matches?.("input, textarea")) return;
  if (el.closest(".topbar")) return;
  const wait = window.matchMedia("(pointer: coarse)").matches ? 300 : 0;
  clearTimeout(focusScrollTimer);
  focusScrollTimer = setTimeout(() => {
    // Only intervene if the field is ACTUALLY obscured (hidden under the keyboard or
    // scrolled off the top). When iOS's own focus-scroll already made it visible, a
    // second scroll is a visible double-reposition.
    //
    // Everything here is measured in the VISUAL viewport — the area left above the
    // keyboard — because that is the space the field has to end up inside. The two
    // viewports differ by exactly the amount that matters: iOS keeps the LAYOUT
    // viewport full height when the keyboard is up, and offsets the visual one.
    // getBoundingClientRect() answers in layout coordinates, so it needs offsetTop
    // taken off it to say where the field sits on the part of the screen you can see.
    const vv = window.visualViewport;
    const vvH = vv?.height ?? window.innerHeight;
    const vvTop = vv?.offsetTop ?? 0;
    const r = el.getBoundingClientRect();
    const top = r.top - vvTop;
    const bottom = r.bottom - vvTop;

    // Move the LEAST that makes the field visible, not scrollIntoView({block:"center"}).
    // Centring was measured moving the page 448px to fix an overlap of about 110 — and
    // it centred in the LAYOUT viewport, the one this function had already decided not
    // to trust, so with a keyboard up it aimed at the middle of a screen half of which
    // was keyboard. A minimum move also keeps the row you tapped near where you tapped
    // it, which is the thing a big jump costs you: after centring, the row you were
    // working on is somewhere you have to find again.
    const delta =
      bottom > vvH - FOCUS_MARGIN
        ? bottom - (vvH - FOCUS_MARGIN)
        : top < FOCUS_MARGIN
          ? top - FOCUS_MARGIN
          : 0;
    if (delta) window.scrollBy({ top: delta, behavior: "smooth" });
  }, wait);
}
useWindowEvent("focusin", onFocusIn); // auto-removes on unmount
onBeforeUnmount(() => clearTimeout(focusScrollTimer));

// Clipboard writes fire from real button clicks (the ⋯ menu items + the share
// button), so the async Clipboard API has the user gesture iOS Safari demands. The
// async-first write + synchronous execCommand fallback lives in the shared copyText()
// util (app/utils/clipboard.ts); flash() just reports the outcome.
async function copy(text: string, msg: string, linkFallbackTitle?: string) {
  if (await copyText(text)) return flash(msg);
  // a blocked clipboard write shouldn't dead-end: for a link, show it selectable
  // so it can be copied by hand; other copies (markdown) fall back to a brief toast
  if (linkFallbackTitle) return showLinkFallback(text, linkFallbackTitle);
  flash("Copy failed");
}
const origin = () => (typeof location !== "undefined" ? location.origin : "");

// The four export actions and the rows that draw them are the ⋯ menu's (EditorMenu,
// through useListExports). What the editor hands it is the link the plain-text copy
// appends: the READ-ONLY link — explicitly, not location.href, which here is
// /e/{code}#{token}. That token is edit access, and this action's whole purpose is
// pasting the result somewhere public.
// A draft has no share code yet — no link rather than a broken one (same guard
// copyShare() makes before offering to copy it).
const exportShareUrl = computed(() => (snapshot.value?.shareCode ? `${origin()}/s/${snapshot.value.shareCode}` : ""));

// the ⋯ actions menu is a custom popover of real <button>s (was a native <select>).
// Each item dispatches from a CLICK — the clipboard actions (markdown, edit link)
// need a direct user gesture, and a <select> change isn't one on iOS Safari, so the
// copy silently failed there. Close on the action itself, an outside tap, a scroll
// gesture on mobile (the toolbar is sticky, so nothing else would), or Escape.
useMenuDismiss(menuOpen, menuRef);

// the sharing panel — same dismiss contract as the ⋯ menu beside it (outside click,
// Escape), and the two are mutually exclusive: they sit adjacent in the topbar, and
// two open popovers over one toolbar read as a glitch
const shareRef = useTemplateRef<HTMLElement>("shareRef");
const shareOpen = ref(false);
useMenuDismiss(shareOpen, shareRef);
watch(shareOpen, (open) => open && (menuOpen.value = false));
watch(menuOpen, (open) => open && (shareOpen.value = false));
function toggleMenu() {
  menuEverOpened.value = true;
  menuOpen.value = !menuOpen.value;
}

function copyShare() {
  // a draft has no shareCode/token yet — nudge instead of copying a broken link
  if (!snapshot.value?.shareCode) return flash("Add an item first to share");
  tally("share_link_copied"); // after the guard: a refused copy is not a copy
  copy(`${origin()}/s/${snapshot.value.shareCode}`, "Read-only link copied", "Read-only link");
}
async function copyEditLink() {
  // a claimed open holds no edit link to copy — the server only ever stored its
  // hash, so this device can't produce one without rotating (which mints a new one)
  if (!c.editToken && c.claimCode)
    return flash("This device doesn’t hold the edit link. Replace it in Sharing to get one");
  if (!c.editToken) return flash("Add an item first to get an edit link");
  if (!(await askConfirm({
    title: "Copy edit link",
    message: "Anyone with this link can edit your list. Only send it to people you trust.",
    confirmLabel: "Copy edit link",
  }))) return;
  tally("share_link_copied"); // after the confirm: a cancelled copy is not a copy
  // /e/{shareCode}#{token} so link previews (Apple Notes/iMessage) show the name;
  // token stays in the fragment (see shared/links.editLinkPath)
  copy(`${origin()}${editLinkPath(snapshot.value?.shareCode, c.editToken)}`, "Edit link copied", "Edit link");
}
async function rotate() {
  if (!(await askConfirm({
    title: "Rotate edit link",
    message: "Make the old edit link stop working and create a new one? Anyone you shared the old link with will lose edit access.",
    confirmLabel: "Rotate link",
    danger: true,
  }))) return;
  const next = await c.rotate();
  if (next) {
    // keep the pretty path (rotate only swaps the token, not the share code)
    history.replaceState(null, "", editLinkPath(snapshot.value?.shareCode, next));
    flash("Edit link rotated");
  }
}
const { copyList } = useCopyList();
async function cloneList() {
  if (!snapshot.value) return;
  const ok = await copyList(snapshot.value, totals.value?.totalMg ?? 0);
  flash(ok ? "List duplicated" : "Couldn’t duplicate. Try again.");
}

// THE TWO WAYS TO STOP HAVING THIS LIST.
//
// A separate page owned both, which made getting rid of a list a trip you took while staring
// straight at the thing you wanted gone: leave the editor, find its row on another
// page, act there. Both now live here, one above the other, because they are the
// same question asked at two strengths — does this leave MY device, or does it leave
// the WORLD — and the answer reads better as a pair than as two pages.
//
// A menu row was said to be too small to hold that distinction; what actually holds
// it is the dialog, which has always been where the difference was explained. The
// rows only have to be told apart at a glance, and they are: one is red and throws
// the list away, the other is plain and takes it off a shelf.
//
// Off on an unsaved draft. shareCode is the reactive stand-in for "has a server
// row": it and the edit token are set in the same breath (createFromDraft), and
// c.editToken is a plain getter that no computed can track. A draft is not yet a
// list — "Create a list" above is what replaces one.
const isSaved = computed(() => !!snapshot.value?.shareCode);

// FORGET: drop this device's claim, leave the list standing. The gentler of the two
// and the one with no server call at all — useMyLists.forget() clears the registry
// entry and this list's on-device copy, and that is the whole of it.
//
// "Leave the list standing" is only true while its token is alive. This menu also
// renders in the "No longer online · saved on device" state — the server 404'd the
// token but a local copy kept the editor standing — and there the on-device copy IS
// the list as far as this browser can reach: forgetting discards it, unsynced edits
// and all, and what's discarded may be all that's left. Same act, two different
// losses; the dialog has always been where the difference between these rows is
// explained, so the dialog (not the row) is what changes.
//
// It MUST navigate away, which is not cosmetic. load() re-registers a list it opens
// (registerOpened, so a link someone sent you is remembered), so a reload while still
// sitting on /e/{code}#{token} would put the entry straight back and the forget would
// silently undo itself.
async function forgetThisList() {
  const token = c.editToken;
  if (!token) return;
  // Captured before the await: the poll could 404 mid-dialog, and the act should
  // match the message the user actually read, not a state that moved under it.
  // Status, not a new remoteMissing getter — "missing" with the editor rendered is
  // exactly the dead-token-with-copy state, and it keeps the dialog agreeing with
  // the chrome: it turns frank on the same beat SyncStatus says "No longer online".
  const dead = status.value === "missing";
  const title = savedListTitle(snapshot.value?.title ?? "");
  if (!(await askConfirm({
    title: "Forget this list",
    // Honest about the cost in both states: alive, the list survives and only this
    // browser's way back into it is what's being dropped; dead, the copy being
    // dropped is the thing itself.
    message: dead
      ? `Forget “${title}”? Its link stopped working, so the copy saved on this device may be all that’s left; forgetting discards it.`
      : `Forget “${title}” on this device? The list stays online for anyone with its link, but you’ll need its edit link to open it again.`,
    confirmLabel: "Forget",
    // marked the way the delete's dialog is: dead, this costs something no link
    // can recover. (Today the dialog renders danger monochrome, like everything
    // in the chrome — the flag records the severity, and any styling AppDialogs
    // ever gives danger will pick this up with the delete's.)
    danger: dead,
  }))) return;
  // Same ordering rule the delete below turns on, for the same reason: teardown
  // writes this list's on-device copy, so forgetting first would leave that copy
  // behind under a token the registry no longer holds.
  c.dispose(ownedEpoch);
  // A dead token's vault decision can never be asked again once the copy is gone —
  // it goes the way deleteList and forgetMissingList send it. A live list's stays:
  // its edit link may well bring the list back (see clearVaultDecisionFor).
  if (dead) clearVaultDecisionFor(token);
  my.forget(token);
  newList({ replace: true });
}

async function deleteThisList() {
  // one capability or the other — a claimed open deletes through the session
  // (see useClaimedLists.deleteClaimed), a held link through the token path
  const token = c.editToken;
  const code = token ? "" : c.claimCode;
  if (!token && !code) return;
  if (!(await askConfirm({
    title: "Delete this list",
    message: `Delete “${savedListTitle(snapshot.value?.title ?? "")}” for everyone? Anyone with the link will lose it, and this can’t be undone.`,
    confirmLabel: "Delete",
    danger: true,
  }))) return;
  // CLOSE THE SESSION FIRST, then delete — the order is the whole of it. Teardown
  // flushes the queue and writes this list's on-device copy; run the other way round,
  // that write lands after useMyLists.forget() has cleared the record and leaves a
  // copy of a deleted list in IndexedDB under a token the registry no longer holds.
  // This way the last edits still reach the server while there's a row to take them.
  c.dispose(ownedEpoch);
  // Straight into a fresh draft: you came here to work on a list, and the one you
  // were on is gone. `replace`, so Back doesn't return to it.
  const deleted = token
    ? await my.deleteList(token)
    : await useClaimedLists().deleteClaimed(code);
  if (deleted) return newList({ replace: true });
  // Offline, or the server refused: nothing was deleted, so put the editor back where
  // it was. The teardown above wrote the list to this device, so reopening the
  // capability restores both the snapshot and whatever hadn't drained out of the queue.
  startSession(token ? { token } : { code });
  flash("Couldn’t delete that list. Check your connection and try again.");
}

// FORGET, FROM THE DEAD END. The pair above needs a loaded list — the ⋯ menu only
// renders with a snapshot. But the switcher can hold a row whose token the server has
// stopped answering (the list deleted, or its link rotated, from another device)
// while this browser kept no local copy. Opening that row lands on the missing state
// below, which offered nothing but "Create a list" — so the dead row survived every
// visit and went on leading back here, unremovable from the one page that knows it's
// dead. The dead end now names the list it couldn't open and offers to forget it:
// the only act left that means anything for a row like that.
//
// Registry lookup by the token load() just tried. c.editToken is a plain getter no
// computed can track, but every change to it moves `status` (load → "loading",
// dispose → "idle"), so the status gate keeps this computed honest. forgetSuperseded
// runs in the same breath the 404 sets the status — a rotate leftover with a live
// sibling row is gone before this state ever renders — so a row found here is the
// list's ONLY row, and forgetting it is not covered by any self-heal.
const missingEntry = computed(() =>
  status.value === "missing"
    ? my.entries.value.find((x) => !!c.editToken && x.editToken === c.editToken)
    : undefined,
);
// With a row in hand the page can say WHICH list refused to open, instead of the
// generic line — which read as a shrug when the list was sitting right there in the
// switcher, plainly "in this browser" in every sense the visitor cares about.
const missingMessage = computed(() =>
  missingEntry.value
    ? `“${savedListTitle(missingEntry.value.title)}” can’t be opened anymore. It may have been deleted, or its edit link changed.`
    : openedByCode.value
      // a claimed open that 404'd/401'd: the list left the account's reach, or the
      // session did — the two things a person can actually check from here
      ? "This list couldn’t be opened from your account. It may have been deleted, or you may need to sign in again on this device."
      : keylessCode.value
        // a fragment-less /e/{code}: the key that opens it for editing is gone from
        // the link, not the list — the read-only view still opens with the same code
        ? "This edit link is missing its key, so it can’t open the list for editing. Ask for the edit link again, or open the read-only view."
        : "This list isn’t in this browser, or the link is invalid.",
);
// A load that ended with nothing to show and no verdict: no copy on the device and
// either no network — it loads itself when the network returns (the controller's
// online watcher) — or a server that didn't answer, which the page offers to retry.
// Before this the page sat on "Loading…" for good, with "Not saved" in the bar.
const unloaded = computed(
  () => !snapshot.value && (status.value === "offline" || status.value === "error"),
);
async function forgetMissingList() {
  // capture before dispose() blanks c.editToken (which empties missingEntry too)
  const entry = missingEntry.value;
  if (!entry) return;
  if (!(await askConfirm({
    title: "Forget this list",
    message: `Forget “${savedListTitle(entry.title)}”? Its link no longer works; this only removes it from your lists on this device.`,
    confirmLabel: "Forget",
  }))) return;
  // Same teardown-first order as the pair above. Nothing here can write it back
  // (no snapshot, so writeLocal no-ops) — kept for the pattern, not a live hazard.
  c.dispose(ownedEpoch);
  // Unlike forgetThisList: this token is dead server-side, so the vault decision
  // keyed by it can never be asked again. It goes the way deleteList sends it.
  clearVaultDecisionFor(entry.editToken);
  my.forget(entry.editToken);
  newList({ replace: true });
}

// The ⋯ menu, now grouped rather than flat.
//
// It used to be eight peers in one column: making a list, moving data in and out,
// and handing out edit access all read as the same kind of thing. The two sharing
// items moved to the sharing panel; what's left splits into the plain actions and
// two SECTIONS you open in place — import and export are each a small set of
// alternatives, and a flat list made you scan six labels to find the one format you
// wanted. One section open at a time, so the menu never doubles in height.
//
// One table drives the markup AND the dispatch, so an action can't exist in one
// without the other (a string-keyed lookup would let a typo no-op).
// Same everOpened guard the other lazy dialogs use, so the chunk is fetched by the
// first open rather than by loading the editor.
const feedbackOpen = ref(false);
const feedbackEverOpened = ref(false);

// ---- the shortcuts sheet ----
// Lazy + mounted on first use, like the other dialogs: a reference nobody has opened
// should cost nobody anything.
const shortcutsOpen = ref(false);
const shortcutsEverOpened = ref(false);
function openShortcuts() {
  shortcutsEverOpened.value = true;
  shortcutsOpen.value = true;
}
// `?` opens it — the convention nearly every keyboard-driven app shares, and the only
// route to a sheet about hidden keys for someone who never opens the ⋯ menu.
//
// Guarded hard, because this editor is very nearly ALL text fields: a "?" typed into
// a name, a note or the feedback box has to stay a "?" — hence the target test — and
// a browser or OS chord that happens to produce one (⌘? is Help on macOS) is not this
// shortcut, hence the modifier test. Alt is deliberately not excluded: it is the copy
// modifier, and holding it while typing produces other characters, not "?".
onKeyStroke("?", (e) => {
  if (e.metaKey || e.ctrlKey) return;
  const el = e.target as HTMLElement | null;
  if (el?.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? "")) return;
  // never on top of another dialog — the sheet would trap focus over the one actually
  // in use, and Escape would then close the wrong thing
  if (document.querySelector(".ovl")) return;
  e.preventDefault();
  openShortcuts();
});

// The rows themselves — the table, its glyphs and its wording — are EditorMenu's;
// the editor only answers what each row asks for. Feedback's dialog is Lazy behind
// its own everOpened guard (Import's watcher sets its own), so opening it is two refs.
function openFeedback() {
  feedbackEverOpened.value = true;
  feedbackOpen.value = true;
}

// Start a fresh, empty draft — no server row until something is added. The current
// list isn't lost: it's auto-saved and lives in "Your lists" behind its own link.
// Two paths, by how this list was reached:
//  - opened via an edit link (/e/{code}#{token}) → route to /e; clearing the hash
//    fires the route watcher, which disposes this session and starts the draft.
//  - a draft minted THIS session at /e — its URL was rewritten to /e/{code}#{token}
//    via replaceState WITHOUT routing, so Vue Router still thinks we're at the bare
//    /e. A nav to /e is then a no-op that never fires the watcher, so reset the
//    session in place (same steps the watcher runs) and clean the URL back to /e.
// `replace` for the dead-token missing state (don't keep it in history); push from a
// live list so Back returns to it — including on the in-place path, which is a live
// list too: PUSH the clean /e so the entry still holding /e/{code}#{token} survives
// underneath it. (replaceState would overwrite the only record of the list the user
// was just on, and Back would leave the editor entirely.)
function newList({ replace = false } = {}) {
  if (route.path === "/e" && !route.hash) {
    startSession(); // the same steps the route watcher runs
    history.pushState(history.state, "", "/e");
    return;
  }
  if (replace) router.replace("/e");
  else router.push("/e");
}

// Both dialogs are Lazy + mounted on first use, so their code (incl. the CSV
// parser + LighterPack link handling behind the import) stays out of the editor's
// boot chunk. Once opened they STAY mounted — an unmount-on-close would cut the
// leave transition short, and re-opens then reuse the fetched component.
const importEverOpened = ref(false);
watch(importOpen, (o) => {
  if (o) importEverOpened.value = true;
});
const { target: correctionTarget } = useCatalogCorrection();
const correctionEverOpened = ref(false);
watch(correctionTarget, (t) => {
  if (t) correctionEverOpened.value = true;
});

function onCorrected(res: { status: string; itemName?: string }) {
  flash(
    res.status === "applied"
      ? "Catalog updated for everyone. Thank you."
      : res.status === "proposed"
        ? "Suggested, pending a citation"
        : res.status === "noop"
          ? "That already matches the catalog"
          : "Couldn’t submit that fix",
  );
}

</script>

<template>
  <div
    ref="editorRef"
    class="editor"
    :class="{ 'editor--split': vaultOpen }"
  >
    <!-- the editor's page heading — visually the title input carries it, but a
         real (hidden) h1 gives AT users a page title on this client-only view -->
    <h1 class="visually-hidden">{{ seo.name ? `${seo.name} — pack list` : "New pack list — Mahonia" }}</h1>
    <header class="topbar">
      <div class="wrap topbar__inner">
        <!-- The list switcher, holding the bar's LEADING edge. A word rather than a
             glyph, so it doesn't join the icon cluster at the other end and so it's
             discoverable without hovering; the count answers "do I have others?"
             before you open it. Outside the v-if, because it's a way OUT of a list
             that failed to load. Hides itself below two lists (see ListMenu). -->
        <ListMenu
          class="editor__lists"
          :current-share-code="snapshot?.shareCode ?? null"
          :hint="showIntro"
          :resumed="resumedHere"
          @new-list="newList()"
          @dismiss-hint="dismissIntro"
        />
        <template v-if="snapshot">
          <!-- sync state + last-edit time, on the bar's leading edge — the space the
               title vacated when it became a page title. It takes the free width, which
               is what pins the icon cluster to the trailing edge. -->
          <!-- The class is on a WRAPPER, not on SyncStatus. This element is what
               splits the bar, so it has to exist even when the component inside it
               decides it has nothing to say (an untouched draft) — see the style. -->
          <div class="topbar__status"><SyncStatus /></div>
          <!-- The view switcher used to sit here. It moved into the page body (see
               ModeBar): the bar had no room for words, and no seat for it at all on the
               read views. What is left in the bar is what acts ON a list rather than
               what shows one. -->
          <!-- the vault palette: pick from gear you already own instead of typing
               each name. Lazy — the pane and the shared vault module it pulls in
               are their own chunk, downloaded the first time it's opened. -->
          <!-- the site's own tooltip, not the native `title`: the browser's takes a
               second to appear, can't be styled, and doesn't respect the column the
               way this one does. It keeps the aria-label on the button (the
               accessible NAME) and adds the visible description. Nothing changes on
               touch — <Tooltip> declines to open where there's no hover. -->
          <!-- …and it stands down while the pane is up, like the share panel and the
               account menu beside it. The pane is a .popover in its own right and it
               opens directly under this button, so the description landed on its top
               corner — and the pane says what it is far better than a word does. -->
          <Tooltip text="My Gear" preferred-placement="bottom" :disabled="vaultOpen">
            <button
              class="btn btn--icon btn--ghost editor__vault"
              :class="{ 'is-on': vaultOpen }"
              aria-label="My Gear"
              :aria-expanded="vaultOpen"
              @click="vaultOpen = !vaultOpen"
            >
              <HugeiconsIcon :icon="SafeBoxIcon" :size="16" :stroke-width="2" />
            </button>
          </Tooltip>
          <!-- The account affordance. The editor has its own topbar and never renders
               SiteTopbar, so until now edit AND checklist mode offered no way to sign
               in, reach your account, or sign out — on the one screen people spend
               their time. `compact` gives it the icon shape this glyph row needs. -->
          <AccountMenu compact has-gear-button />
          <!-- Sharing is one panel, not an icon plus two buried menu items. The
               trigger keeps the same glyph and slot it had as a bare copy button. -->
          <div ref="shareRef" class="menu editor__sharemenu">
            <Tooltip text="Sharing" preferred-placement="bottom" :disabled="shareOpen">
              <button
                type="button"
                class="btn btn--icon btn--ghost editor__share"
                :class="{ 'is-on': shareOpen }"
                aria-label="Sharing"
                aria-haspopup="dialog"
                :aria-expanded="shareOpen"
                @click="shareOpen = !shareOpen"
              >
                <HugeiconsIcon :icon="Share08Icon" :size="16" :stroke-width="2" />
              </button>
            </Tooltip>
            <Transition name="menu">
              <LazySharePanel
                v-if="shareOpen && snapshot"
                :snapshot="snapshot"
                :edit-token="c.editToken"
                :auth-headers="c.authHeaders()"
                :read-url="snapshot.shareCode ? `${origin()}/s/${snapshot.shareCode}` : ''"
                :edit-url="c.editToken ? `${origin()}${editLinkPath(snapshot.shareCode, c.editToken)}` : ''"
                @close="shareOpen = false"
                @copy-read="copyShare"
                @copy-edit="copyEditLink"
                @rotate="rotate"
              />
            </Transition>
          </div>
          <div ref="menuRef" class="menu">
            <!-- a custom popover of real <button>s (was a native <select>): the
                 clipboard items need a direct click gesture, which a <select> change
                 isn't on iOS Safari. The kebab toggles it; each item runs on click. -->
            <!-- …and the description stands down once the menu it describes is open,
                 like the two controls beside it. The tooltip drops BELOW the trigger
                 and the menu drops out of the same edge, so an undismissed one landed
                 squarely on the menu's first row — the pointer is still on the button
                 that opened it, so nothing else would take it down. -->
            <Tooltip text="More actions" preferred-placement="bottom" :disabled="menuOpen">
              <button
                type="button"
                class="btn btn--icon btn--ghost menu__btn"
                aria-label="More actions"
                aria-haspopup="true"
                :aria-expanded="menuOpen"
                @pointerenter="warmMenu"
                @focus="warmMenu"
                @click="toggleMenu"
              >
                <HugeiconsIcon :icon="EllipsisIcon" :size="16" :stroke-width="2" />
              </button>
            </Tooltip>
            <!-- The menu itself — rows, export section, foot — is EditorMenu, Lazy
                 behind everOpened like the dialogs: fetched and mounted on the first
                 open, off the first load until then. Its transition lives inside it
                 (with `appear`, for that first mount). What comes back up is one
                 emit per row; the editor keeps the verbs. -->
            <LazyEditorMenu
              v-if="menuEverOpened"
              :open="menuOpen"
              :first-run="isFirstRun"
              :saved="isSaved"
              :opened-by-code="openedByCode"
              :snapshot="snapshot"
              :share-url="exportShareUrl"
              @close="menuOpen = false"
              @flash="flash"
              @people="peopleOpen = true"
              @duplicate="cloneList"
              @import="importOpen = true"
              @shortcuts="openShortcuts"
              @feedback="openFeedback"
              @forget="forgetThisList"
              @delete="deleteThisList"
            />
          </div>
        </template>
      </div>
    </header>

    <!-- data-mode drives the gear↔packing row swap in CSS (atoms/item.scss) — the rows
         themselves never learn the mode, which is what keeps a switch from re-rendering
         all of them. is-rowswitching gates the entering face's fade to actual switches,
         so a row appearing for any other reason (a new item, the first mount) doesn't
         flash the animation. -->
    <!-- data-filter-person narrows the rows to one person the same way data-mode
         swaps their faces: one body attribute, matched in CSS against each row's
         own data-person (atoms/item.scss). Absent = everyone. -->
    <!-- has-people widens the actions track to its six-icon worst case (the person
         trigger joined the cluster) — a body class, so peopleless lists keep the
         narrower track and no row subscribes to anything; see atoms/item.scss -->
    <main
      v-if="snapshot && totals"
      id="main-content"
      tabindex="-1"
      class="wrap editor__body"
      :class="{ 'is-rowswitching': modeSwitching, 'has-people': people.length > 0 }"
      :data-mode="mode"
      :data-filter-person="personFilterAttr"
    >
      <!-- WHICH VIEW OF THIS LIST. First thing under the toolbar, and part of the PAGE
           rather than the chrome: it scrolls away with everything else. A row of its own
           rather than a seat in the bar above, because that row has no width left — it
           measures 338px of its 343px budget on a 375px phone, and words need ~207px
           against the 116px three icons took. -->
      <ModeBar class="editor__modes" :modes="MODES" :current="mode" label="View mode" @pick="(k) => (mode = k as EditorMode)" />
      <!-- The list name is a page title, not a toolbar field: large, borderless, with a
           ghosted placeholder, at the top of the content — matching what the two read
           views have always done (ReadonlyListView's h1). -->
      <ListHead :snapshot="snapshot" :distance-is-headline="mode === 'plan'" @toast="flash" />
      <!-- The totals bar stands down while planning: that view has its own headline (the
           route's distance), and two display-size figures on one screen would make you
           choose which one the page is about. The pack's weight isn't lost — it rides in
           the plan's chips, and per day in the burn-down column. -->
      <!-- THE PAGE'S ONE BIG NUMBER, and one ELEMENT for all three views. It used to be
           two — the weight inside TotalsBar, the distance inside TrailPlanPanel — so
           switching to planning unmounted one and mounted the other, and the figure
           jumped and re-counted every time. Here it stays put and only the value under it
           changes, which is also what lets the count tween between modes. -->
      <Headline
        class="editor__headline"
        :value="headline.value"
        :unit="headline.unit"
        :options="headline.options"
        :label="headline.label"
        :trigger-label="headline.triggerLabel"
        :caption="filterCaption"
        title="Change unit"
        @pick="headline.pick"
      />
      <!-- v-show, not v-if: presence is constant, visibility follows the mode — so
           leaving planning doesn't rebuild the bar (it's stateless, but its remount rode
           every plan exit's flush). display:none skips it in layout and the a11y tree
           exactly as absence did, and the flex gap collapses with it. -->
      <!-- view.*: while narrowed to one person the chips, the bar and the category
           legend all describe that person's pack. The `??` never runs — see the
           `view` computed — it only narrows the type for the template. -->
      <TotalsBar
        v-show="mode !== 'plan'"
        :headline="false"
        :list="view.list ?? snapshot"
        :totals="view.totals ?? totals"
        @set-unit="(u) => c.setUnit(u)"
      />
      <!-- Whose gear is this? An edit link you hold is either your own list on a
           second device or one a friend shared, and nothing in the link says which
           — so rather than guess, ask once and remember. Nothing has reached the
           vault at this point; the answer is what decides, and dismissing IS
           answering.
           INLINE, after the weight chart: it's a question about THIS list, and a
           panel floating over the page overstates a thing you can ignore. No lede
           — the reason we're asking is our problem, not something to make you read. -->
      <Prompt
        :show="!!vaultPrompt"
        variant="inline"
        dismiss-label="Don’t add this list’s gear to My Gear"
        @dismiss="c.answerVaultPrompt(false)"
      >
        <template #icon><HugeiconsIcon :icon="SafeBoxIcon" :size="16" :stroke-width="2" /></template>
        Add this list’s gear to My Gear?
        <template #action>
          <button class="btn btn--quiet editor__vaultadd" @click="c.answerVaultPrompt(true)">Add</button>
        </template>
      </Prompt>

      <!-- ...and "Add" opens the chooser, because a list you didn't start is
           usually part yours and part theirs. Lazy AND gated: it's reachable only
           from the banner above, which most lists never show, so its chunk waits for
           the first "Add" (see vaultPickerEverOpened). -->
      <LazyVaultPickerModal
        v-if="vaultPickerEverOpened"
        :caps="vaultPicker"
        :unit="snapshot.displayUnit"
        @confirm="(keep) => c.confirmVaultPicker(keep)"
        @cancel="c.cancelVaultPicker()"
      />

      <!-- WHO. The chips narrow the list to one person's load — in the gear view
           and the packing view alike, so it sits above the packbar and stands down
           only for planning. Rendered only once the list names anyone (ListHead's
           "Add people" affordance is the way in before that). -->
      <PeopleBar
        v-if="people.length"
        v-show="mode !== 'plan'"
        :people="people"
        :selected="pf.selected.value"
        :show-unassigned="hasUnassigned"
        :weights="chipWeights"
        @pick="(id) => (pf.selected.value = id)"
      />
      <!-- a filter that matches nothing says so, instead of standing every folder
           down into a silent blank page — the ListMenu empty-state voice -->
      <FilterEmpty v-if="emptyFilterName" v-show="mode !== 'plan'" :name="emptyFilterName" @clear="pf.clear()" />
      <!-- Lazy like the vault picker: most lists never name anyone, and the manager
           has no business in their first paint. v-if — state resets per open. -->
      <LazyPeopleModal v-if="peopleOpen" @close="peopleOpen = false" />

      <!-- packing progress: slides+fades in on entering packing (grid-rows 1fr↔0fr,
           the shared reveal recipe) so the folders below ease down instead of jumping.
           The slide is keyed on data-mode in CSS (same shape as the folder collapse),
           NOT a <Transition> — a Vue Transition's LEAVE forces a synchronous reflow
           mid-patch, and on a mode switch that reflow lands on a tree the data-mode
           flip just dirtied wholesale: it was the entire remaining packing→gear stall
           (~45ms on a 150-row list) after the rows and folder chrome stopped
           re-rendering. The browser now runs the same slide at frame time for free.
           v-if only on the DATA condition (an empty list has no bar in any mode). -->
      <div v-if="packProgress.total" class="packbar-reveal">
        <div class="packbar t-sm">
          <span class="t-num" aria-live="polite">{{ packProgress.done }} of {{ packProgress.total }} packed</span>
          <button
            v-if="anyPacked"
            type="button"
            class="btn btn--quiet packbar__clear"
            @click="clearChecks"
          >Clear checks</button>
        </div>
      </div>

      <!-- The plan. Lazy on purpose: the panel pulls in the trip model, and planning is a
           mode most visits never enter — it has no business on the editor's first load.
           The everPlan latch keeps that laziness while ending the rebuild: the panel
           mounts on the FIRST entry into planning and then stays, and every switch after
           that is the data-mode CSS reveal below — the same move the rows and the pack
           bar make, for the same reason (a Vue Transition's leave forces a synchronous
           reflow mid-patch, and unmounting rebuilt the whole panel per visit). Staying
           mounted is also what lets the route map keep its pan and zoom across switches.

           Its OWN reveal, not the pack bar's, though the slide is the same. That recipe
           clips its child permanently, which is right for a one-line bar and wrong here:
           the elevation chart's hover readout is positioned above the chart's own box, so
           a standing clip cut the reading off. This one clips only while it moves. -->
      <div v-if="everPlan && snapshot && totals" class="planreveal">
        <LazyTrailPlanPanel :snapshot="snapshot" :totals="totals" />
      </div>

      <!-- The gear stands down while you plan. Planning asks a different question of the
           same list — how the trip breaks into days and what the pack weighs on each — and
           the answer is above; the rows underneath would just be a long scroll between you
           and it. Same move packing mode makes, which swaps the rows rather than adding to
           them.
           v-show, not v-if: hiding is what the design wants, and unmounting was what it
           quietly cost — coming back from planning rebuilt every row (the same
           half-second stall the row swap had, for the same reason; see ItemRow's
           two-Transition comment). display:none takes the rows out of layout, paint
           and the accessibility tree exactly as absence did. -->
      <div v-show="mode !== 'plan'" class="editor__folders">
        <FolderSection
          v-for="f in sortedFolders"
          :key="f.id"
          :list="snapshot"
          :folder="f"
          :items="itemsByFolder.get(f.id) ?? NO_ITEMS"
          :packed="packed"
          @toast="flash"
        />
      </div>
      <!-- same split as the folders above: presence follows the DATA (v-if — most lists
           have no ungrouped rows and shouldn't carry the section), visibility follows
           the MODE (v-show — so leaving planning doesn't rebuild these rows either) -->
      <section v-if="ungrouped.length" v-show="mode !== 'plan'" class="panel editor__ungrouped">
        <p class="t-label">Unfiled</p>
        <!-- prev-id follows this section's render order, so the indent affordance
             points at the row actually shown above -->
        <ItemRow
          v-for="(it, i) in ungrouped"
          :key="it.id"
          :list="snapshot"
          :item="it"
          :prev-id="ungrouped[i - 1]?.id ?? null"
          @toast="flash"
        />
      </section>

      <!-- v-show, matching the folder chrome: presence is constant, visibility follows
           the mode, and a switch mounts nothing. (A half-typed folder name can't leak
           across modes — any pointer or Tab out of the input commits it via blur
           before the mode can change.) -->
      <div v-show="mode === 'edit'" class="addfolder editor__addfolder">
        <input
          v-if="addingFolder"
          ref="newFolderRef"
          class="addfolder__input"
          placeholder="Folder name"
          aria-label="New folder name"
          autocorrect="off"
          spellcheck="false"
          @keydown.enter.prevent="commitAddFolder"
          @keydown.esc="addingFolder = false"
          @blur="commitAddFolder"
        />
        <button v-else type="button" class="addfolder__btn" @click="openAddFolder">Add folder</button>
      </div>
    </main>

    <main v-else-if="status === 'missing'" id="main-content" tabindex="-1" class="wrap editor__missing">
      <p class="t-muted">{{ missingMessage }}</p>
      <!-- a truncated edit link: the read-only view is the way back to THIS list, so
           it takes the primary and starting over steps down beside it -->
      <NuxtLink v-if="keylessCode" :to="`/s/${keylessCode}`" class="btn btn--primary">Open the read-only view</NuxtLink>
      <button :class="['btn', keylessCode ? 'btn--quiet' : 'btn--primary']" @click="newList({ replace: true })">Create a list</button>
      <!-- quiet, under the primary: the way forward stays the page's loudest offer,
           and retiring the row that led here is the calm cleanup beside it -->
      <button v-if="missingEntry" class="btn btn--quiet" @click="forgetMissingList">Forget this list</button>
    </main>

    <main v-else-if="unloaded" id="main-content" tabindex="-1" class="wrap editor__missing">
      <p class="t-muted">
        {{ status === "offline"
          ? "This list isn’t saved on this device, and there’s no connection to load it from. It will open on its own once you’re back online."
          : "This list couldn’t be loaded. Check your connection and try again." }}
      </p>
      <button v-if="status === 'error'" class="btn btn--primary" @click="c.retryLoad()">Try again</button>
      <button :class="['btn', status === 'error' ? 'btn--quiet' : 'btn--primary']" @click="newList({ replace: true })">Create a list</button>
    </main>

    <main v-else id="main-content" tabindex="-1" class="wrap editor__missing">
      <p class="t-muted">Loading…</p>
    </main>

    <Transition name="toast">
      <div
        v-if="pendingUndo"
        class="toast undobar"
        @mouseenter="undoHovered = true"
        @mouseleave="undoHovered = false"
        @focusin="undoFocused = true"
        @focusout="undoFocused = false"
      >
        <span class="t-sm">{{ pendingUndo.verb ?? "Removed" }} <strong>{{ pendingUndo.label }}</strong></span>
        <button class="undobar__btn t-sm" @click="c.undoRemove()">
          <HugeiconsIcon :icon="UndoIcon" :size="14" :stroke-width="2" /> Undo
        </button>
      </div>
      <div v-else-if="toast" class="toast t-sm">{{ toast }}</div>
    </Transition>

    <!-- the pane arrives from the edge it lives on; motion is in VaultPane's own
         styles, next to the geometry that decides which edge that is -->
    <Transition name="vaultpane">
      <!-- adding a whole category lands a folder plus N rows further down the page
           than the pane you clicked in, so it gets a toast — a single item's row
           answers for itself in place ("Already added"), a set doesn't -->
      <LazyVaultPane
        v-if="vaultOpen"
        v-model:width="vaultWidth"
        @close="vaultOpen = false"
        @added="(name: string) => flash(`Added ${name}`)"
      />
    </Transition>

    <LazyCatalogCorrectionModal v-if="correctionEverOpened" @done="onCorrected" />
    <LazyImportModal v-if="importEverOpened" :open="importOpen" @close="importOpen = false" />
    <LazyFeedbackModal v-if="feedbackEverOpened" :open="feedbackOpen" @close="feedbackOpen = false" />
    <LazyShortcutsModal v-if="shortcutsEverOpened" :open="shortcutsOpen" @close="shortcutsOpen = false" />
  </div>
</template>

<style scoped lang="scss">
/* The editor fills the viewport on short lists and grows with long ones. */
.editor {
  display: flex;
  flex-direction: column;
  min-height: 100svh;
}
/* Split view: the vault occupies the right of the screen, so the editor's CONTENT
   gives up that width rather than sitting underneath it. Padding on the content
   blocks (not a margin on .wrap) keeps .wrap's centring intact — it re-centres
   inside the narrower space, which is what makes this read as two panes and not as
   a page shoved sideways.
   Applied to the editor shell, while the sticky topbar breaks back out to keep
   spanning the full viewport: it's the site's bar, not the list column's, and
   stopping it short of the vault made it look like a second panel had been cut out
   of the page. Desktop only — below $bp-full the pane is a bottom sheet that
   overlays by design, and the list needs its full width. */
@media (min-width: $bp-full + 1px) {
  .editor--split {
    padding-right: calc(var(--vault-w) + 2 * var(--space-4));
  }
  /* ...then the topbar breaks back out to the full viewport. It can't simply be left
     unpadded: main IS the .wrap (centred, max-width --measure), so padding it would
     only eat its own content box and never move the column. The inset has to be on
     the shell, and the bar opts out of it. */
  .editor--split > .topbar {
    margin-right: calc(-1 * (var(--vault-w) + 2 * var(--space-4)));
  }
  /* The inset EASES between the two widths rather than jumping, so opening and
     closing the pane is one movement: the list gives up the space as the pane slides
     in, and flows back into it as the pane leaves. It used to snap on the click —
     ~400px in a single frame, and on the way out the page had already re-flowed
     before the pane finished going, so you saw the result before the cause.
     Declared on the BASE selector as well as the modifier, which is what makes the
     removal animate too — and the pair is what sets the direction: the modifier's
     --dur-slow runs while the class is on (opening, alongside the pane's own
     entrance), the base's --dur when it comes off (closing, alongside the exit).
     --ease, never the popover curves: this is the document flow, and a spring here
     would overshoot the column's width and wobble the text inside it.
     The bar's break-out has to move on exactly the same clock — its negative margin
     is what cancels this padding, so a bar that jumped while the column eased would
     be the wrong width for the whole transition. */
  .editor {
    transition: padding-right var(--dur) var(--ease);
  }
  .editor > .topbar {
    transition: margin-right var(--dur) var(--ease);
  }
  .editor--split,
  .editor--split > .topbar {
    transition-duration: var(--dur-slow);
  }
  /* …but NOT while the divider is being dragged. --vault-w is rewritten every frame
     of a drag (VaultPane's startResize writes it straight onto this element), and an
     eased padding would make the column chase the divider a fifth of a second behind
     the cursor. The pane marks the element for the length of the gesture — and for
     the arrow-key resize, which steps the same property — so sizing stays rigid and
     only the open/close eases. */
  .editor--sizing,
  .editor--sizing > .topbar {
    transition: none;
  }
}
.editor > main {
  flex: 1 0 auto;
}
/* .topbar itself (sticky, paper, rule) is global — main.scss */
.topbar__inner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-block: var(--space-3);
  /* On a phone the cluster is six controls at the 44px touch floor plus the switcher,
     and it did not fit 375px even with two mode segments — it was ~17px over before a
     third was added, which clipped the ⋯ menu off the trailing edge entirely.
     The gap is the only slack that costs nothing: --tap is the HIG minimum and every
     other candidate is a control's hit area. Halving it here buys 20px without shrinking
     a single target. */
  @media (max-width: $bp-stack) {
    gap: var(--space-1);
  }
  /* Leading edge, and the TOOL CLUSTER pushes itself right (see .topbar__status below).
     This used to be justify-content: flex-end, holding the icons trailing by
     shoving everything — a workaround for the bar's only flexible item being
     CONDITIONAL: SyncStatus says nothing on an untouched draft, so with no
     flex:1 anywhere the cluster fell back to the leading edge.
     That workaround broke the moment something needed to STAY at the leading edge:
     with nothing to take up the slack, the list switcher was carried right along
     with the icons and landed in the middle of the bar. An auto margin on the
     cluster does the same job without depending on a sibling existing. */
}
/* Sizes to its own words and shrinks if it must (min-width:0 lets its ellipsis
   fire) — but does NOT grow. Its own auto margin eats the free space first, and a
   `flex: 1` here would then resolve its 0% basis against nothing left and collapse the
   line to a sliver. */
.topbar__status {
  /* WHERE THE BAR SPLITS. Everything after this acts ON the list; everything before it
     says which list you are looking at.
     The auto margin used to live on the mode toggle, which held this seat until it moved
     into the page. It could not simply move to the next element: the vault and share
     buttons are wrapped by <Tooltip>, so a class on the BUTTON lands on the wrapper's
     child and the flex item it needed to be on is the wrapper. Putting it here works
     whatever the cluster is made of.
     A PLAIN <div>, and that is the fix rather than a tidiness. The class used to ride
     SyncStatus itself, on the reasoning that "an auto margin on a zero-width item still
     eats the free space before it" — true of a zero-width item, and SyncStatus is not
     one: it is `v-if="shown"`, so with nothing to report it renders NO ELEMENT, taking
     this margin with it. On an untouched draft the whole tool cluster then collapsed
     back against the switcher. The bar's own layout can't be a child's to opt out of. */
  margin-right: auto;
  flex: 0 1 auto;
  min-width: 0;
}
/* Directly under the toolbar and above the list's title. Not sticky: it belongs to the
   page, not the chrome.
   Only the one step below it — the bar already carries 4px of its own padding, and the
   title below brings its own leading. A full step on top of those two read as a gap
   somebody forgot to close. */
.editor__modes {
  margin-bottom: var(--space-1);
}
/* The big figure sits between the switcher and whatever that switcher chose. Its own
   space, because it belongs to neither — it is the page's headline in all three views. */
/* NO margin of its own. The body is a flex column with a --space-4 gap, so a margin here
   is a SECOND gap stacked on the first — which is how the number ended up 32px clear of
   the totals and 48 clear of the elevation chart, two different distances from two
   different stacks. One gap, the body's, and both views sit the same distance below the
   figure they belong to. (.totals and .plan drop their own top padding to match.) */
.editor__headline {
  margin-bottom: 0;
}

/* The plan's reveal: the pack bar's slide without its standing clip — see the template.
   Keyed on the body's data-mode like the pack bar, not on enter/leave classes. The
   at-rest hidden state is display:none — the panel leaves layout, paint, the a11y tree
   AND the body's flex gap exactly as unmounting did — and the slide still runs both
   ways because display rides the transition as a discrete property: entering flips it
   to grid at the transition's start, leaving holds grid until the fade lands. Browsers
   without allow-discrete just snap between the same two correct states. */
/* both display gates carry !important — the #210 lesson: a mode gate on a latched
   element competes with every later layout rule on it, and importance is what holds
   that line (transitions still outrank importance in the cascade, so the discrete
   display animation above is unaffected) */
.planreveal {
  display: none !important;
  grid-template-rows: 1fr;
  transition:
    grid-template-rows var(--dur) var(--ease),
    opacity var(--dur) var(--ease),
    display var(--dur) allow-discrete;
}
.editor__body[data-mode="plan"] .planreveal {
  display: grid !important;
}
.editor__body:not([data-mode="plan"]) .planreveal {
  grid-template-rows: 0fr;
  opacity: 0;
}
.planreveal > * {
  min-height: 0;
}
/* the clip exists ONLY while the rows are moving, which is the only time it is needed —
   the switch beat (is-rowswitching, 250ms) comfortably covers the 200ms slide */
.editor__body.is-rowswitching .planreveal > * {
  overflow: hidden;
}
/* entering plays the same 0fr→1fr slide the old <Transition> enter played. Gated on the
   switch beat so a page LOADED in planning mounts at rest — the old no-`appear`
   behavior — while a real switch (beat active) starts from the collapsed state. */
@starting-style {
  .editor__body.is-rowswitching[data-mode="plan"] .planreveal {
    grid-template-rows: 0fr;
    opacity: 0;
  }
}
/* The title block (name + trail link) belongs to ListHead.vue — it owns its own layout
   so the hover affordance, the title, and the link keep one DOM order. */

/* the icon cluster is rigid so it can't be nudged by anything that joins the row */
.editor__share,
.editor__vault,
.menu {
  flex: none;
}

/* Toolbar actions recede until hovered, keyboard-focused, or open. Scope this to
   the editor so icon buttons elsewhere keep their existing emphasis. */
.editor > .topbar :deep(.btn--icon) {
  color: var(--ink-3);
}
@media (hover: hover) and (pointer: fine) {
  .editor > .topbar :deep(.btn--icon:hover) {
    color: var(--ink);
  }
}
.editor > .topbar :deep(.btn--icon:focus-visible),
.editor > .topbar :deep(.btn--icon[aria-expanded="true"]) {
  color: var(--ink);
}

/* on = the pane is open: the icon takes full ink and a soft ground, so the button
   reads as a held state rather than a hover */
.editor__vault.is-on {
  color: var(--ink);
  background: var(--paper-2);
}
/* The sharing panel is ~343px of links and activity hanging off a 32px button that
   sits near the right end of the bar. `.menu` makes that button the containing block,
   so `right: 0` put the panel's right edge at the BUTTON's right edge — and on a
   375px phone its left edge landed at -11, taking the rounded corner and half the
   padding off-screen.
   Dropping the wrapper out of the positioning chain on small screens hands the panel
   the sticky .topbar instead, which spans the viewport. Scoped to this one wrapper on
   purpose: `.menu` is a shared atom (the row popovers use it too), and making IT
   static would move every anchored menu in the app. */
@media (max-width: $bp-stack) {
  .editor__sharemenu {
    position: static;
  }
}
/* the sharing panel is open — same held-state treatment the vault toggle uses, so
   the two topbar popovers signal their state identically */
.editor__share.is-on {
  color: var(--ink);
  background: var(--paper-2);
}
/* the ⋯ menu's Export section, its ruled-off feet, its short-phone scroller
   (.editor__actions) and the one coloured row in the chrome (.editor__delete) are
   EditorMenu's now, styled there — a scoped rule here can't reach a child's rows */
/* the popover's look + open/close come from the shared .menu atom (controls.scss);
   the editor only nudges the trailing cluster (toggle · share · kebab) right into the
   gutter so the kebab lines up with the item rows' drag handle below. The title group
   (flex:1) absorbs the freed space, so the cluster reflows as a unit.

   Keyed to the LAST .menu, not every one. Sharing now needs a .menu wrapper of its
   own (it anchors a popover), and a bare `.menu` rule pulled that one 13px right too
   — which closed the gap to the kebab and opened a matching one before it. Only the
   element that actually sits in the gutter should reach into it. */
.menu:last-child {
  margin-right: -13px;
}
.editor__body {
  /* The folder-to-folder rhythm, named once and read twice: .editor__folders uses it
     as its gap, and .editor__addfolder has to reach the SAME distance from a different
     starting point. It lives HERE, on their common ancestor, and not on .editor__folders
     — the two are SIBLINGS, and a custom property inherits down the tree, never
     sideways, so declaring it there left the other reading an invalid value and
     collapsing its margin to 0. */
  --folder-gap: var(--space-7);
  padding-block: var(--space-4) var(--space-7);
  display: flex;
  flex-direction: column;
  /* one step up from --space-4. This is the gap directly under the trail link (the last
     row ListHead owns), and it was reading tight against the page title above it now
     that the sync line no longer sits in this column. Moves the editor toward the air
     the read views already give the same seam (.view is a --space-6 column). */
  gap: var(--space-5);
}
/* the first-run pointer moved out of the column and onto the list switcher it
   points at — it lives in ListMenu now, tethered to that control */
/* the inline vault ask's affirmative — quiet like the rest of the banner, and
   deepening to full ink on hover the way every under-link on the site does */
.editor__vaultadd {
  flex: none;
  color: var(--ink);
  font-weight: 600;
}
/* packing progress — one quiet line between the totals and the checklist. The
   count is the info; "Clear checks" sits beside it in the site's under-link
   voice (ink-3, darkens on hover, no chrome). */
/* reveal wrapper: carries the tuck + the grid-rows height/fade slide (shared recipe
   with ItemRow's .reveal). The tuck lives here, not on the inner .packbar, so the
   inner line isn't clipped by the wrapper's overflow as it slides. */
.packbar-reveal {
  display: grid;
  grid-template-rows: 1fr;
  /* the body's --space-4 gap reads roomier before a bare text line than before
     the folder blocks — tuck it up toward the totals it annotates */
  margin-top: calc(-1 * var(--space-2));
  /* the slide, driven by the mode attribute below rather than by enter/leave
     classes — see the template comment. margin-top rides the transition so the
     collapsed state can contribute EXACTLY 0px to the flow (matching the old
     unmounted state) without snapping the tuck at either end. visibility is
     discrete: it holds through the fade-out and flips at the end, taking the
     hidden bar (and its Clear button) out of the tab order and the
     accessibility tree exactly as unmounting did. */
  transition:
    grid-template-rows var(--dur) var(--ease),
    opacity var(--dur) var(--ease),
    margin-top var(--dur) var(--ease),
    visibility 0s linear var(--dur);
}
.editor__body:not([data-mode="pack"]) .packbar-reveal {
  grid-template-rows: 0fr;
  opacity: 0;
  margin-top: 0;
  visibility: hidden;
}
.editor__body[data-mode="pack"] .packbar-reveal {
  transition-delay: 0s; /* visibility flips visible immediately on entering packing */
}
.packbar-reveal > * {
  min-height: 0;
  overflow: hidden;
}
.packbar {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  color: var(--ink-2);
}
/* .packbar__clear kept as the print-hide hook (see print.scss); its button styling
   comes from the shared .btn--quiet */
.editor__folders {
  display: flex;
  flex-direction: column;
  gap: var(--folder-gap);
}
/* load reveal: folders cascade in (SPACE10 signature), ~50ms apart.
   fill-mode `backwards` (not `both`): holds the hidden start-state during each
   folder's stagger delay, then settles to the natural style afterwards. `both`
   would retain an identity `transform` post-animation, making every folder a
   stacking context that traps the add-item autocomplete dropdown's z-index
   inside its folder (so later folders paint over it). */
.editor__folders > * {
  animation: rise var(--dur-slow) var(--ease) backwards;
}
/* cascade cadence lives in one token (--stagger, ~31ms — SPACE10's kinetic-type
   step), not five magic numbers; child 1 leads at 0, the rest step off it */
.editor__folders > *:nth-child(2) {
  animation-delay: var(--stagger);
}
.editor__folders > *:nth-child(3) {
  animation-delay: calc(var(--stagger) * 2);
}
.editor__folders > *:nth-child(4) {
  animation-delay: calc(var(--stagger) * 3);
}
.editor__folders > *:nth-child(5) {
  animation-delay: calc(var(--stagger) * 4);
}
.editor__folders > *:nth-child(n + 6) {
  animation-delay: calc(var(--stagger) * 5);
}
.editor__ungrouped {
  padding: var(--space-3) var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* "Unfiled" is a folder heading in everything but name, so it sits the same
   --space-1 above its first row that a real folder name does (.folder__head, in the
   atom). The section's own flex gap already provides exactly that; an extra
   margin-bottom here put the editor's heading 12px off its rows while the share
   views' identical heading sat at 4px — the same list, two rhythms. */
/* reads like a folder heading — same type as a folder name, dimmer, flush-left
   with the folder names above it. Tapping it swaps the label for an inline text
   field. */
/* the .addfolder atom (controls.scss); only where it sits is ours */
.editor__addfolder {
  align-self: flex-start;
  /* sit a full folder-gap below the last folder. This element is a SIBLING of
     .editor__folders, not a child, so it already carries the body's --space-4 gap and
     only needs the remainder — but the target is --folder-gap, read from the one
     declaration above rather than restated. */
  margin-top: calc(var(--folder-gap) - var(--space-4));
}
.editor__missing {
  padding-block: var(--space-9);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-4);
}
/* the toast base + its enter/leave motion now live in the shared .toast atom
   (controls.scss), used by the read views' menu too; the undo bar just adds its
   inner layout on top of that pill. */
</style>
