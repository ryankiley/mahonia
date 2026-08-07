<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { Backpack02Icon, Cancel01Icon, CheckmarkSquare02Icon, ChevronDownIcon, Delete02Icon, EllipsisIcon, Route02Icon, SafeBoxIcon, Share08Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { editLinkPath } from "~~/shared/links";
import { tripHeadline } from "~~/shared/trailDistance";
import { formatWeight } from "~~/shared/weights";
import type { Item, Unit } from "~~/shared/types";
import { bySortOrder, groupItemsByFolder, groupItemsByParent, ungroupedTopLevel } from "~~/shared/weights";

// The whole editor surface (its own sticky topbar + flex shell + the shared
// SiteFooter). Rendered by the page routes: /e (bare, ssr:false) and /e/[code]
// (client-only under a server-rendered <head>). It is CLIENT-ONLY — it holds a
// singleton controller with IndexedDB + window listeners, so it never runs on the
// server (the /e/[code] page wraps it in <ClientOnly>; /e is ssr:false).

const c = useGearList();
const router = useRouter();
const my = useMyLists();
// app-wide dialogs (replace native confirm()/the copy dead-end) — see useDialogs
const { confirm: askConfirm, showLinkFallback } = useDialogs();

const snapshot = c.snapshot;
const totals = c.totals;
const status = c.status;
const pendingUndo = c.pendingUndo;
const vaultPrompt = c.vaultPrompt;
const vaultPicker = c.vaultPicker;

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
// a write can throw on quota or in private mode; the preference just doesn't
// outlive the session then, which is never worth failing the interaction over
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not worth reporting */
  }
}
const INTRO_DISMISSED_KEY = "gear.intro.dismissed.v1";
const introDismissed = ref(localStorage.getItem(INTRO_DISMISSED_KEY) === "1");
function dismissIntro() {
  introDismissed.value = true;
  remember(INTRO_DISMISSED_KEY, "1");
}
const showIntro = computed(
  () => isFirstRun.value && savedCount.value > 0 && !introDismissed.value && !vaultOpen.value,
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
const seo = computed(() => editorSeo(snapshot.value?.title, totals.value));
const listName = computed(() => seo.value.name);
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
// items whose folder was removed (e.g. by a concurrent editor) land here, not as invisible ghosts
// (ungroupedTopLevel: nested children render under their parent, via ItemRow)
const ungrouped = computed(() =>
  snapshot.value ? ungroupedTopLevel(snapshot.value.items) : [],
);
// render folders in sortOrder so drag-reorder (moveFolderBefore) reflects immediately
const sortedFolders = computed(() =>
  snapshot.value ? [...snapshot.value.folders].sort(bySortOrder) : [],
);
// one grouping pass per snapshot, handed to each FolderSection — so a keystroke
// in one folder doesn't make every folder re-filter + re-sort the whole item array.
// Folders are passed so each group honors its own `sortBy` (manual = drag order).
const itemsByFolder = computed(() => {
  const map = groupItemsByFolder(snapshot.value?.items ?? [], snapshot.value?.folders ?? []);
  // A just-added, still-blank row is pinned to the BOTTOM of its (possibly sorted)
  // folder — otherwise a name/weight sort would immediately yank the empty row it
  // autofocused off to the top, away from where you clicked "Add an item". Once you
  // name it and blur, pendingBlankId clears and it slots into sorted position.
  const pid = c.pendingBlankId.value;
  if (pid) {
    for (const group of map.values()) {
      const i = group.findIndex((it) => it.id === pid);
      if (i >= 0) {
        group.push(...group.splice(i, 1));
        break;
      }
    }
  }
  return map;
});
// one children pass per snapshot, threaded to every row — so a parent row doesn't
// re-scan the whole item array for its children on each render
const childrenByParent = computed(() => groupItemsByParent(snapshot.value?.items ?? []));
const NO_ITEMS: Item[] = [];

// Which of the three views of this list you're in. Was a single `packed` boolean; it
// couldn't hold a third state, and every alternative to widening it meant teaching the
// row components about a mode they don't care about.
//
// `packed` survives as a COMPUTED, so the prop threaded down to FolderSection and ItemRow
// keeps its exact old contract — a row still only ever asks "am I a checklist row?", and
// stays ignorant that planning exists. That's what keeps this change to this file.
export type EditorMode = "edit" | "pack" | "plan";
const MODE_ORDER: EditorMode[] = ["edit", "pack", "plan"];
// Unlike the other gear.*.v1 preferences this one is genuinely new behaviour: mode used
// to reset on reload. Planning is somewhere you WORK across sittings, so it stays put.
const MODE_KEY = "gear.mode.v1";
function storedMode(): EditorMode {
  const m = localStorage.getItem(MODE_KEY) as EditorMode | null;
  return m && MODE_ORDER.includes(m) ? m : "edit";
}
const mode = ref<EditorMode>(storedMode());
watch(mode, (m) => remember(MODE_KEY, m));
const packed = computed(() => mode.value === "pack");

/**
 * What the big number is, per view.
 *
 * Planning is about the walk, so it shows the route's distance; the other two are about
 * the pack, so they show its weight. One object rather than four scattered computeds,
 * because every field here has to change together — a value from one view beside a unit
 * picker from another is a control that lies about what it will do.
 *
 * `triggerLabel` is the SPOKEN version of the whole trigger, and it is not the same string
 * as `label`: the trigger draws the page's biggest figure, and an aria-label of "Distance
 * unit" on it replaces that figure rather than qualifying it, so the number went unspoken.
 * The menu it opens keeps the plain `label` — see OptionMenu's triggerLabel.
 */
const headline = computed(() => {
  if (mode.value === "plan") {
    const trip = tripHeadline(snapshot.value ?? {});
    return {
      value: trip.value,
      unit: trip.unit as string,
      options: DISTANCE_UNIT_OPTIONS,
      label: "Distance unit",
      triggerLabel: `${trip.value} ${trip.unit}, change unit`,
      pick: (u: string) => c.setMeta({ trailDistanceUnit: u }),
    };
  }
  const unit = snapshot.value?.displayUnit ?? "g";
  const value = formatWeight(totals.value?.totalMg ?? 0, unit, { withUnit: false });
  return {
    value,
    unit: unit as string,
    options: WEIGHT_UNIT_OPTIONS,
    label: "Weight unit",
    triggerLabel: `${value} ${unit}, change unit`,
    pick: (u: string) => c.setUnit(u as Unit),
  };
});
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
  { key: "edit", label: "Gear", icon: Backpack02Icon },
  { key: "pack", label: "Packing", icon: CheckmarkSquare02Icon },
  { key: "plan", label: "Planning", icon: Route02Icon },
] as const satisfies readonly { key: EditorMode; label: string; icon: unknown }[];

// The vault palette. Closed by default and only ever opened deliberately, so the
// pane's chunk (and the vault read behind it) costs nothing until it's wanted.
const vaultOpen = ref(false);
// Split-pane width, remembered: how much of the screen you're willing to give the
// vault is a working preference, not a per-session one. The pane clamps the value
// it writes back, so a hand-edited or stale figure can't wedge the panel off-screen.
const VAULT_W_KEY = "gear.vault.width.v1";
const vaultWidth = ref(clampVaultWidth(Number(localStorage.getItem(VAULT_W_KEY))));
watch(vaultWidth, (w) => remember(VAULT_W_KEY, String(w)));
// packing progress — rows checked / rows total (a row is one check, whatever its qty)
const packProgress = computed(() => {
  const items = snapshot.value?.items ?? [];
  return { done: items.filter((i) => i.packed).length, total: items.length };
});
// start the next trip clean: uncheck everything (each row is its own op, so the
// existing queue/flush machinery — offline, CAS, live-sync — applies unchanged)
async function clearChecks() {
  if (!snapshot.value) return;
  if (!(await askConfirm({
    title: "Clear checks",
    message: "Uncheck every packed item? Your gear stays. Only the check marks reset.",
    confirmLabel: "Clear checks",
  }))) return;
  if (!snapshot.value) return; // re-check after the awaited dialog
  for (const it of snapshot.value.items) if (it.packed) c.updateItem(it.id, { packed: false });
}
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
// the travelling wash shared with the other menus (see useMenuPlate). Section
// HEADERS deliberately carry no [data-row] — they open a group rather than doing
// something, so the wash shouldn't claim them as a destination.
const { plateRef: kebabPlateRef, listRef: kebabListRef, placing: kebabPlacing, on: kebabPlateOn } = useMenuPlate();
const menuRef = useTemplateRef<HTMLElement>("menuRef");
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

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
// The epoch of the session THIS instance started. On an /e ↔ /e/[code] route
// swap, Nuxt runs the incoming page's setup (whose watcher below starts a new
// session) BEFORE this instance unmounts — passing our own epoch lets dispose()
// no-op when the session is no longer ours, instead of tearing down the newer
// instance's in-flight load (which stranded the editor on "Loading…").
let ownedEpoch: number | undefined;
// Tear down whatever session this instance owns and start the one `token` names (or a
// fresh draft when it names none), re-capturing the epoch. The ordering is the whole
// point — see the note above — so it lives in ONE place, called by the route watcher
// and by newList's in-place reset alike.
function startSession(token?: string) {
  c.dispose(ownedEpoch);
  if (token) c.load(token);
  else c.startDraft();
  ownedEpoch = c.epoch; // load()/startDraft() mint their epoch synchronously
}
// Drive load off the reactive hash so back/forward + same-route nav between two
// of your lists dispose+reload correctly (the editor singleton holds one list).
watch(
  () => route.hash,
  (h) => {
    // decode HERE, not inside startSession: a malformed hash ("#%") throws, and that
    // throw must land before the dispose, exactly as it always has.
    // first run: ownedEpoch is undefined → dispose is unconditional, clearing (and
    // flushing) whatever session a previous page instance left behind
    const token = decodeURIComponent((h || "").replace(/^#/, ""));
    startSession(token); // no token = a fresh, unsaved draft (persists on first real content)
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  clearTimeout(toastTimer);
  c.dispose(ownedEpoch);
});

// On touch, the browser's own "scroll the focused field into view" is flaky — it
// sometimes no-ops, leaving the field sitting under the keyboard. Force it: once
// the keyboard has had time to animate up, centre the field in the space that's
// left. Gated to coarse pointers (desktop clicks shouldn't jump the page) and
// skips the sticky-header fields, which are always visible anyway.
let focusScrollTimer: ReturnType<typeof setTimeout> | undefined;
function onFocusIn(ev: FocusEvent) {
  const el = ev.target as HTMLElement | null;
  if (!el?.matches?.("input, textarea")) return;
  if (el.closest(".topbar")) return;
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  clearTimeout(focusScrollTimer);
  focusScrollTimer = setTimeout(() => {
    // Only intervene if the field is ACTUALLY obscured (hidden under the keyboard or
    // scrolled off the top). When iOS's own focus-scroll already made it visible, a
    // second scrollIntoView is a visible double-reposition. visualViewport.height is
    // the area left above the keyboard.
    const vvH = window.visualViewport?.height ?? window.innerHeight;
    const r = el.getBoundingClientRect();
    if (r.bottom > vvH || r.top < 0) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, 300);
}
useWindowEvent("focusin", onFocusIn); // auto-removes on unmount
onBeforeUnmount(() => clearTimeout(focusScrollTimer));

function flash(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2000);
}
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

// the four export actions + their chunk warm-up live in useListExports, shared
// with the read views' ⋯ menu so the copy + error handling can't drift.
//
// The share URL the plain-text copy appends is the READ-ONLY link — explicitly, not
// location.href, which here is /e/{code}#{token}. That token is edit access, and this
// action's whole purpose is pasting the result somewhere public.
const { warmExporters, copyPlainText, copyMarkdown, downloadCsv, downloadJson } = useListExports(
  () => snapshot.value,
  flash,
  // a draft has no share code yet — no link rather than a broken one (same guard
  // copyShare() makes before offering to copy it)
  () => (snapshot.value?.shareCode ? `${origin()}/s/${snapshot.value.shareCode}` : ""),
);

// the ⋯ actions menu is a custom popover of real <button>s (was a native <select>).
// Each item dispatches from a CLICK — the clipboard actions (markdown, edit link)
// need a direct user gesture, and a <select> change isn't one on iOS Safari, so the
// copy silently failed there. Close on the action itself, an outside tap, or Escape.
onClickOutside(menuRef, () => (menuOpen.value = false));
useWindowEvent("keydown", (e) => {
  if (e.key === "Escape" && menuOpen.value) menuOpen.value = false;
});

// the sharing panel — same dismiss contract as the ⋯ menu beside it (outside click,
// Escape), and the two are mutually exclusive: they sit adjacent in the topbar, and
// two open popovers over one toolbar read as a glitch
const shareRef = useTemplateRef<HTMLElement>("shareRef");
const shareOpen = ref(false);
onClickOutside(shareRef, () => (shareOpen.value = false));
useWindowEvent("keydown", (e) => {
  if (e.key === "Escape" && shareOpen.value) shareOpen.value = false;
});
watch(shareOpen, (open) => open && (menuOpen.value = false));
watch(menuOpen, (open) => open && (shareOpen.value = false));
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function copyShare() {
  // a draft has no shareCode/token yet — nudge instead of copying a broken link
  if (!snapshot.value?.shareCode) return flash("Add an item first to share");
  copy(`${origin()}/s/${snapshot.value.shareCode}`, "Read-only link copied", "Read-only link");
}
async function copyEditLink() {
  if (!c.editToken) return flash("Add an item first to get an edit link");
  if (!(await askConfirm({
    title: "Copy edit link",
    message: "Anyone with this link can edit your list. Only send it to people you trust.",
    confirmLabel: "Copy edit link",
  }))) return;
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

// DELETING THE LIST YOU'RE LOOKING AT.
//
// /mine owned this alone until now, which made getting rid of a list a trip you
// took while staring straight at the thing you wanted gone: leave the editor, find
// its row on another page, delete it there. That page keeps the job — it shows every
// list at once and has the room to set "Remove from device" beside "Delete for
// everyone", a distinction a menu row can't hold — but in here there is only ONE
// list and only one of those two meanings is worth having, so this row is the
// destructive one and the dialog says so in the same words /mine uses.
//
// Off on an unsaved draft. shareCode is the reactive stand-in for "has a server
// row": it and the edit token are set in the same breath (createFromDraft), and
// c.editToken is a plain getter that no computed can track. A draft is not yet a
// list — "Create a list" above is what replaces one.
const canDelete = computed(() => !!snapshot.value?.shareCode);

async function deleteThisList() {
  const token = c.editToken;
  if (!token) return;
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
  // Straight into a fresh draft rather than back to /mine: you came here to work on a
  // list, and the one you were on is gone. `replace`, so Back doesn't return to it.
  if (await my.deleteList(token)) return newList({ replace: true });
  // Offline, or the server refused: nothing was deleted, so put the editor back where
  // it was. The teardown above wrote the list to this device, so reopening the token
  // restores both the snapshot and whatever hadn't drained out of the queue.
  startSession(token);
  flash("Couldn’t delete that list. Check your connection and try again.");
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

const MENU_ACTIONS = [
  { label: "Create a list", run: () => newList() },
  { label: "Duplicate this list", run: cloneList },
  // Import stays a plain row. It has exactly ONE entry point — the modal, which
  // offers the file and the LighterPack link side by side — and a disclosure holding
  // a single item is a click that reveals nothing you couldn't have been shown. It
  // also forced a label long enough to set the whole menu's width.
  { label: "Import a list…", run: () => { importOpen.value = true; } },
  // Feedback is reachable from the footer on every page, but the editor is where
  // people actually spend their time and where a long list puts that footer far below
  // the fold — by the time you have something to say about a row, the link is a scroll
  // away. The toolbar is in reach from anywhere in the list.
  { label: "Send feedback…", run: () => { feedbackEverOpened.value = true; feedbackOpen.value = true; } },
];
const MENU_SECTIONS = [
  {
    key: "export",
    label: "Export",
    items: [
      // First, because it's the one people reach for most: it's the format a comment
      // box actually accepts. Markdown below it is the same idea for somewhere that
      // renders it (Apple Notes, a README, a forum that takes it).
      { label: "Copy as plain text", run: copyPlainText },
      { label: "Copy as Markdown", run: copyMarkdown },
      { label: "Download CSV", run: downloadCsv },
      { label: "Download JSON", run: downloadJson },
    ],
  },
] as const;

const openSection = ref<string | null>(null);
function toggleSection(key: string) {
  openSection.value = openSection.value === key ? null : key;
  // warm the exporter chunks when the EXPORT section opens, not when the menu does.
  // Opening ⋯ to duplicate a list shouldn't pull three parsers you never asked for;
  // opening Export is the first honest signal that one of them is about to run.
  if (openSection.value === "export") warmExporters();
}
// a re-opened menu starts collapsed — the previous session's open section is not a
// preference, and restoring it would put a different item under the cursor
watch(menuOpen, (open) => open || (openSection.value = null));

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
    class="editor"
    :class="{ 'editor--centered': !(snapshot && totals), 'editor--split': vaultOpen }"
    :style="{ '--vault-w': `${vaultWidth}px` }"
  >
    <!-- the editor's page heading — visually the title input carries it, but a
         real (hidden) h1 gives AT users a page title on this client-only view -->
    <h1 class="visually-hidden">{{ listName ? `${listName} — pack list` : "New pack list — Mahonia" }}</h1>
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
          @new-list="newList()"
          @dismiss-hint="dismissIntro"
        />
        <template v-if="snapshot">
          <!-- sync state + last-edit time, on the bar's leading edge — the space the
               title vacated when it became a page title. It takes the free width, which
               is what pins the icon cluster to the trailing edge. -->
          <SyncStatus class="topbar__status" />
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
          <Tooltip text="Gear vault" preferred-placement="bottom">
            <button
              class="btn btn--icon btn--ghost editor__vault"
              :class="{ 'is-on': vaultOpen }"
              aria-label="Gear vault"
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
          <AccountMenu compact />
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
            <Tooltip text="More actions" preferred-placement="bottom">
              <button
                type="button"
                class="btn btn--icon btn--ghost menu__btn"
                aria-label="More actions"
                aria-haspopup="true"
                :aria-expanded="menuOpen"
                @click="toggleMenu"
              >
                <HugeiconsIcon :icon="EllipsisIcon" :size="16" :stroke-width="2" />
              </button>
            </Tooltip>
            <Transition name="menu">
              <ul v-if="menuOpen" ref="kebabListRef" class="popover menu__list" role="menu" aria-label="More actions" v-on="kebabPlateOn">
                <!-- the travelling wash (atoms/controls.scss + useMenuPlate) -->
                <li role="none" aria-hidden="true">
                  <span ref="kebabPlateRef" class="menu__plate" :class="{ 'is-placing': kebabPlacing }" />
                </li>
                <!-- no "Your lists" here — the footer already carries that link.
                     Close BEFORE the action runs, matching the old dispatch order. -->
                <li v-for="a in MENU_ACTIONS" :key="a.label" role="none">
                  <button type="button" data-row role="menuitem" class="menu__item" @click="menuOpen = false; a.run()">{{ a.label }}</button>
                </li>
                <!-- Import / Export expand in place. The section header is not a
                     menuitem — it opens a group rather than doing anything — so it
                     carries aria-expanded and its items stay the menuitems. -->
                <li v-for="s in MENU_SECTIONS" :key="s.key" role="none" class="menu__sect">
                  <button
                    type="button"
                    class="menu__item menu__secthead"
                    :aria-expanded="openSection === s.key"
                    @click="toggleSection(s.key)"
                  >
                    {{ s.label }}
                    <HugeiconsIcon :icon="ChevronDownIcon" class="menu__sectchev"
                      :class="{ 'is-open': openSection === s.key }"
                      :size="14"
                      :stroke-width="2"
                      aria-hidden="true" />
                  </button>
                  <Transition name="reveal">
                    <div v-if="openSection === s.key" class="reveal">
                  <ul class="menu__sectlist" role="group" :aria-label="s.label">
                    <li v-for="a in s.items" :key="a.label" role="none">
                      <button type="button" data-row role="menuitem" class="menu__item menu__sectitem" @click="menuOpen = false; a.run()">{{ a.label }}</button>
                    </li>
                  </ul>
                    </div>
                  </Transition>
                </li>
                <!-- Deleting this list, last and under a hairline. Not one of the rows
                     above it: everything there makes, copies or moves a list, and this
                     one ends it — the same reason ListMenu rules "New list" off its list
                     of lists. A rule earns its keep between two KINDS of thing.
                     Quiet ink and a trash glyph rather than a colour, because the chrome
                     is monochrome — the same call /mine makes to tell its destructive
                     remove from its harmless one. -->
                <li v-if="canDelete" role="none" class="editor__menufoot">
                  <button
                    type="button"
                    data-row
                    role="menuitem"
                    class="menu__item editor__delete"
                    @click="menuOpen = false; deleteThisList()"
                  >
                    <HugeiconsIcon :icon="Delete02Icon" :size="14" :stroke-width="2" aria-hidden="true" />
                    Delete this list
                  </button>
                </li>
              </ul>
            </Transition>
          </div>
        </template>
      </div>
    </header>

    <main v-if="snapshot && totals" id="main-content" tabindex="-1" class="wrap editor__body">
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
        title="Change unit"
        @pick="headline.pick"
      />
      <TotalsBar
        v-if="mode !== 'plan'"
        :headline="false"
        :list="snapshot"
        :totals="totals"
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
        dismiss-label="Don’t add this list’s gear to my gear vault"
        @dismiss="c.answerVaultPrompt(false)"
      >
        <template #icon><HugeiconsIcon :icon="SafeBoxIcon" :size="16" :stroke-width="2" /></template>
        Add this list’s gear to your vault?
        <template #action>
          <button class="btn btn--quiet editor__vaultadd" @click="c.answerVaultPrompt(true)">Add</button>
        </template>
      </Prompt>

      <!-- ...and "Add" opens the chooser, because a list you didn't start is
           usually part yours and part theirs. Lazy: it's reachable only from the
           banner above, which most lists never show. -->
      <LazyVaultPickerModal
        :caps="vaultPicker"
        :unit="snapshot.displayUnit"
        @confirm="(keep) => c.confirmVaultPicker(keep)"
        @cancel="c.cancelVaultPicker()"
      />

      <!-- packing progress: slides+fades in on entering packing (grid-rows 1fr↔0fr,
           the shared reveal recipe) so the folders below ease down instead of jumping -->
      <Transition name="packbar">
        <div v-if="packed && packProgress.total" class="packbar-reveal">
          <div class="packbar t-sm">
            <span class="t-num" aria-live="polite">{{ packProgress.done }} of {{ packProgress.total }} packed</span>
            <button
              v-if="packProgress.done"
              type="button"
              class="btn btn--quiet packbar__clear"
              @click="clearChecks"
            >Clear checks</button>
          </div>
        </div>
      </Transition>

      <!-- The plan. Lazy on purpose: the panel pulls in the trip model, and planning is a
           mode most visits never enter — it has no business on the editor's first load.

           Its OWN reveal, not the pack bar's, though the slide is the same. That recipe
           clips its child permanently, which is right for a one-line bar and wrong here:
           the elevation chart's hover readout is positioned above the chart's own box, so
           a standing clip cut the reading off. This one clips only while it moves. -->
      <Transition name="planreveal">
        <div v-if="mode === 'plan' && snapshot && totals" class="planreveal">
          <LazyTrailPlanPanel :snapshot="snapshot" :totals="totals" />
        </div>
      </Transition>

      <!-- The gear stands down while you plan. Planning asks a different question of the
           same list — how the trip breaks into days and what the pack weighs on each — and
           the answer is above; the rows underneath would just be a long scroll between you
           and it. Same move packing mode makes, which swaps the rows rather than adding to
           them. -->
      <div v-if="mode !== 'plan'" class="editor__folders">
        <FolderSection
          v-for="f in sortedFolders"
          :key="f.id"
          :list="snapshot"
          :folder="f"
          :items="itemsByFolder.get(f.id) ?? NO_ITEMS"
          :children-by-parent="childrenByParent"
          :packed="packed"
          @toast="flash"
        />
      </div>
      <section v-if="ungrouped.length && mode !== 'plan'" class="panel editor__ungrouped">
        <p class="t-label">Ungrouped</p>
        <!-- prev-id follows this section's render order, so the indent affordance
             points at the row actually shown above -->
        <ItemRow
          v-for="(it, i) in ungrouped"
          :key="it.id"
          :list="snapshot"
          :item="it"
          :children-by-parent="childrenByParent"
          :prev-id="ungrouped[i - 1]?.id ?? null"
          :packed="packed"
          @toast="flash"
        />
      </section>

      <div v-if="mode === 'edit'" class="editor__addfolder">
        <input
          v-if="addingFolder"
          ref="newFolderRef"
          class="editor__addfolderinput"
          placeholder="Folder name"
          aria-label="New folder name"
          autocorrect="off"
          spellcheck="false"
          @keydown.enter.prevent="commitAddFolder"
          @keydown.esc="addingFolder = false"
          @blur="commitAddFolder"
        />
        <button v-else type="button" class="editor__addfolderbtn" @click="openAddFolder">Add folder</button>
      </div>
    </main>

    <main v-else-if="status === 'missing'" id="main-content" tabindex="-1" class="wrap editor__missing">
      <p class="t-muted">This list isn’t in this browser, or the link is invalid.</p>
      <button class="btn btn--primary" @click="newList({ replace: true })">Create a list</button>
    </main>

    <main v-else id="main-content" tabindex="-1" class="wrap editor__missing">
      <p class="t-muted">Loading…</p>
    </main>

    <!-- in-toolbar: this page carries BOTH footer destinations in its own top bar —
         the list switcher and the gear vault — so the footer stops repeating them.
         Every other page keeps them, because nothing up there carries them. -->
    <SiteFooter in-toolbar />

    <Transition name="toast">
      <div
        v-if="pendingUndo"
        class="toast undobar"
        @mouseenter="undoHovered = true"
        @mouseleave="undoHovered = false"
        @focusin="undoFocused = true"
        @focusout="undoFocused = false"
      >
        <span class="t-sm">Removed <strong>{{ pendingUndo.label }}</strong></span>
        <button class="undobar__btn t-sm" @click="c.undoRemove()">
          <HugeiconsIcon :icon="Undo02Icon" :size="14" :stroke-width="2" /> Undo
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
  </div>
</template>

<style scoped lang="scss">
/* column shell so the slim legal footer pins to the bottom on the short
   (empty / missing) states and sits below the list on long ones */
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
   Applied to main + footer and NOT to .editor itself, so the sticky topbar keeps
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
}
.editor > main {
  flex: 1 0 auto;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-topbar);
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}
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
     child and the flex item it needed to be on is the wrapper. Putting it here instead
     works whatever the cluster is made of — and works even on an untouched draft, where
     SyncStatus renders empty, because an auto margin on a zero-width item still eats the
     free space before it. */
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

/* The plan's reveal: the pack bar's slide without its standing clip — see the template. */
.planreveal {
  display: grid;
  grid-template-rows: 1fr;
}
.planreveal > * {
  min-height: 0;
}
/* the clip exists ONLY while the rows are moving, which is the only time it is needed */
.planreveal-enter-active > *,
.planreveal-leave-active > * {
  overflow: hidden;
}
.planreveal-enter-active,
.planreveal-leave-active {
  transition:
    grid-template-rows var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}
.planreveal-enter-from,
.planreveal-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
/* The title block (name + trail link) belongs to ListHead.vue — it owns its own layout
   so the hover affordance, the title, and the link keep one DOM order. */

/* the icon cluster is rigid so it can't be nudged by anything that joins the row */
.editor__share,
.editor__vault,
.menu {
  flex: none;
}

/* on = the pane is open: the icon takes full ink and a soft ground, so the button
   reads as a held state rather than a hover */
.editor__vault.is-on {
  color: var(--ink);
  background: var(--paper-2);
}
.editor__share {
  color: var(--ink-2);
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
/* the ⋯ menu's Export section is the shared .menu__sect disclosure (controls.scss),
   which the read views' menu uses too */
/* ...and its FOOT holds the one action that ends the list, ruled off from the rest.
   The rule sits on the <li> rather than on the row, so it spans the same width the
   travelling plate does (both measure from the popover's padding box) instead of the
   row's own inset. Same construction as ListMenu's .lm__foot — one hairline, in the
   one place a menu has two kinds of thing in it. */
.editor__menufoot {
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  border-top: 1px solid var(--line);
}
/* Quiet by default and full ink on approach: destructive, but not something to be
   drawn to. It sits a tone below its neighbours (--ink-3, the tone .share__revoke
   takes for replacing an edit link) and comes up to --ink when the plate arrives, so
   it reads as deliberate rather than as a warning you have to keep dismissing.
   flex, because .menu__item is display:block — the glyph needs a row. */
.editor__delete {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.editor__delete:hover,
.editor__delete:focus-visible {
  color: var(--ink);
}
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
  /* no bottom padding: the footer's margin-top is the single content→footer gap
     (matches the inter-folder rhythm), so it isn't doubled up here */
  padding-block: var(--space-4) 0;
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
.packbar-enter-active,
.packbar-leave-active {
  transition:
    grid-template-rows var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}
.packbar-enter-from,
.packbar-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
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
/* "Ungrouped" is a folder heading in everything but name, so it sits the same
   --space-1 above its first row that a real folder name does (.folder__head, in the
   atom). The section's own flex gap already provides exactly that; an extra
   margin-bottom here put the editor's heading 12px off its rows while the share
   views' identical heading sat at 4px — the same list, two rhythms. */
/* reads like a folder heading — same type as a folder name, dimmer, flush-left
   with the folder names above it. Tapping it swaps the label for an inline text
   field. */
.editor__addfolder {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  /* sit a full folder-gap below the last folder. This element is a SIBLING of
     .editor__folders, not a child, so it already carries the body's --space-4 gap and
     only needs the remainder — but the target is --folder-gap, read from the one
     declaration above rather than restated. */
  margin-top: calc(var(--folder-gap) - var(--space-4));
}
/* label + inline input share the folder-name type; label is dimmer */
.editor__addfolderbtn,
.editor__addfolderinput {
  padding: 0;
  background: none;
  border: 0;
  font-family: var(--font);
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
}
.editor__addfolderbtn {
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.editor__addfolderbtn:hover {
  /* full ink, like every quiet add affordance (.folder__addbtn, .item-nest__add) —
     the house hover for quiet text actions (controls.scss) */
  color: var(--ink);
}
.editor__addfolderinput {
  color: var(--ink);
  min-width: 12rem;
}
.editor__addfolderinput:focus {
  outline: none;
}
.editor__addfolderinput::placeholder {
  color: var(--ink-3);
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
/* On the empty states (missing / loading) the message is the whole page, so centre
   it in the viewport: drop the footer's top gap that would otherwise cap the grown
   <main> short of the footer and pull the optical centre upward. */
.editor--centered :deep(.foot) {
  margin-top: 0;
}
/* the toast base + its enter/leave motion now live in the shared .toast atom
   (controls.scss), used by the read views' menu too; the undo bar just adds its
   inner layout on top of that pill. */
</style>
