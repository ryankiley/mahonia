<script setup lang="ts">
import { Backpack, Ellipsis, Share2, SquareCheck, Undo2 } from "@lucide/vue";
import { listToMarkdown } from "~~/shared/exporters/markdown";
import { listToCsv } from "~~/shared/exporters/csv";
import { uid } from "~~/shared/id";
import type { Item, ListSnapshot } from "~~/shared/types";
import { bySortOrder, groupItemsByFolder } from "~~/shared/weights";

// The editor opts out of the default layout (its own sticky topbar + flex shell),
// but renders the shared SiteFooter at the bottom so the footer is the same site-wide.
definePageMeta({ layout: false });

const c = useGearList();
const router = useRouter();

const snapshot = c.snapshot;
const totals = c.totals;
const status = c.status;
const pendingUndo = c.pendingUndo;

// Reflect the list name in the tab title, matching the read views (/l, /s).
useHead({
  title: () => {
    if (!snapshot.value) return "Mahonia";
    return `${snapshot.value.title || "Untitled list"} — Mahonia`;
  },
});
// items whose folder was removed (e.g. by a concurrent editor) land here, not as invisible ghosts
const ungrouped = computed(() =>
  snapshot.value ? snapshot.value.items.filter((i) => !i.folderId) : [],
);
// render folders in sortOrder so drag-reorder (moveFolderBefore) reflects immediately
const sortedFolders = computed(() =>
  snapshot.value ? [...snapshot.value.folders].sort(bySortOrder) : [],
);
// one grouping pass per snapshot, handed to each FolderSection — so a keystroke
// in one folder doesn't make every folder re-filter + re-sort the whole item array
const itemsByFolder = computed(() => groupItemsByFolder(snapshot.value?.items ?? []));
const NO_ITEMS: Item[] = [];

const packed = ref(false);
const importOpen = ref(false);
const menuOpen = ref(false);
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
// Drive load off the reactive hash so back/forward + same-route nav between two
// of your lists dispose+reload correctly (the editor singleton holds one list).
watch(
  () => route.hash,
  (h) => {
    c.dispose();
    const token = decodeURIComponent((h || "").replace(/^#/, ""));
    if (token) c.load(token);
    else c.startDraft(); // no token = a fresh, unsaved draft (persists on first real content)
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  clearTimeout(toastTimer);
  c.dispose();
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
useEventListener(window, "focusin", onFocusIn); // auto-removes on unmount
onBeforeUnmount(() => clearTimeout(focusScrollTimer));

function flash(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2000);
}
// Clipboard writes fire from real button clicks (the ⋯ menu items + the share
// button), so the async Clipboard API has the user gesture iOS Safari demands. Keep a
// synchronous execCommand('copy') fallback off a hidden textarea for older browsers
// where the async API is missing or rejected. (See controls.scss for sibling iOS quirks.)
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // off-screen but still selectable; fixed + opacity:0 avoids iOS scroll-to-field + zoom
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
async function copy(text: string, msg: string) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      flash(msg);
      return;
    }
  } catch {
    // async API unavailable or rejected — fall through to the legacy path,
    // still within the user gesture.
  }
  flash(legacyCopy(text) ? msg : "Copy failed");
}
const origin = () => (typeof location !== "undefined" ? location.origin : "");

// the ⋯ actions menu is a custom popover of real <button>s (was a native <select>).
// Each item dispatches from a CLICK — the clipboard actions (markdown, edit link)
// need a direct user gesture, and a <select> change isn't one on iOS Safari, so the
// copy silently failed there. Close on the action itself, an outside tap, or Escape.
onClickOutside(menuRef, () => (menuOpen.value = false));
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && menuOpen.value) menuOpen.value = false;
});
function runMenu(action: string) {
  menuOpen.value = false;
  switch (action) {
    case "duplicate": return cloneList();
    case "import": return openImport();
    case "markdown": return copyMarkdown();
    case "csv": return downloadCsv();
    case "json": return downloadJson();
    case "editlink": return copyEditLink();
    case "rotate": return rotate();
  }
}

function copyShare() {
  // a draft has no shareCode/token yet — nudge instead of copying a broken link
  if (!snapshot.value?.shareCode) return flash("Add an item first to share");
  copy(`${origin()}/s/${snapshot.value.shareCode}`, "Read-only link copied");
}
function copyEditLink() {
  if (!c.editToken) return flash("Add an item first to get an edit link");
  if (!confirm("Anyone with this link can edit your list. Only send it to people you trust.")) return;
  copy(`${origin()}/e#${c.editToken}`, "Edit link copied");
}
async function rotate() {
  if (!confirm("Make the old edit link stop working and create a new one?")) return;
  const next = await c.rotate();
  if (next) {
    history.replaceState(null, "", `/e#${next}`);
    flash("Edit link rotated");
  }
}
function copyMarkdown() {
  if (snapshot.value) copy(listToMarkdown(snapshot.value), "Copied as Markdown");
}
async function cloneList() {
  if (!snapshot.value) return;
  // fresh ids so the copy is fully independent; keep folder→item links + notes/weights
  const idMap = new Map<string, string>();
  const folders = snapshot.value.folders.map((f) => {
    const nid = uid();
    idMap.set(f.id, nid);
    return { ...f, id: nid };
  });
  const items = snapshot.value.items.map((i) => ({
    ...i,
    id: uid(),
    folderId: i.folderId ? (idMap.get(i.folderId) ?? null) : null,
    packed: false,
  }));
  const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
    method: "POST",
    body: { title: `${snapshot.value.title || "Untitled list"} (copy)`, data: { folders, items } },
  });
  router.push(`/e#${useMyLists().registerCreated(res, totals.value?.totalMg ?? 0)}`);
  flash("List duplicated");
}
function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
// Name the downloaded file after the list's NAME (what the user typed), e.g.
// "Summer JMT" → "summer-jmt.json", so the saved file is recognisable. Falls back to
// the URL slug, then "gear" (an unnamed draft has neither a title nor a slug yet).
function fileBase(): string {
  const fromTitle = (snapshot.value?.title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return fromTitle || snapshot.value?.slug || "gear";
}
function downloadCsv() {
  if (!snapshot.value) return;
  download(`${fileBase()}.csv`, listToCsv(snapshot.value), "text/csv");
  flash("CSV downloaded");
}
function downloadJson() {
  if (!snapshot.value) return;
  const { title, description, displayUnit, folders, items } = snapshot.value;
  download(
    `${fileBase()}.json`,
    JSON.stringify({ title, description, displayUnit, folders, items }, null, 2),
    "application/json",
  );
  flash("JSON downloaded");
}

function openImport() {
  importOpen.value = true;
}

function newList() {
  // a fresh draft — no server row until something is added. Clearing the hash fires
  // the route watcher → startDraft; replace so Back doesn't return to the dead token.
  router.replace("/e");
}

// no steady-state "Saved" noise — only transient saving / error / loading shows.
// "offline" is the one persistent cue: edits are held on device until the
// connection returns, so we say so rather than crying "Not saved".
const statusLabel = computed(() =>
  ({ loading: "Loading…", saving: "Saving…", synced: "", error: "Not saved ↻", offline: "Offline · saved on device", missing: "", idle: "" })[status.value] || "",
);

function onCorrected(res: { status: string; itemName?: string }) {
  flash(
    res.status === "applied"
      ? "Catalog updated for everyone — thank you"
      : res.status === "proposed"
        ? "Suggested — pending a citation"
        : res.status === "noop"
          ? "That already matches the catalog"
          : "Couldn’t submit that fix",
  );
}

</script>

<template>
  <div class="editor" :class="{ 'editor--centered': !(snapshot && totals) }">
    <header class="topbar">
      <div class="wrap topbar__inner">
        <div v-if="snapshot" class="editor__titlewrap">
          <input
            class="field editor__title"
            :value="snapshot.title"
            placeholder="Untitled list"
            autocorrect="off"
            spellcheck="false"
            @change="c.setMeta({ title: ($event.target as HTMLInputElement).value })"
          />
          <!-- always rendered (height reserved) so the transient "Saving…" never
               grows the sticky header and shoves the list down on every flush -->
          <span
            class="editor__status"
            :data-state="status"
            aria-live="polite"
          >{{ statusLabel }}</span>
        </div>
        <template v-if="snapshot">
          <div class="modetoggle" role="group" aria-label="View mode">
            <!-- one pill tracks between the two segments (damped --ease, never overshoot —
                 a tracking indicator must not leave its track); the icons sit above it -->
            <span class="modetoggle__pill" :class="{ 'is-packing': packed }" aria-hidden="true" />
            <button
              type="button"
              class="modetoggle__opt"
              :class="{ 'is-active': !packed }"
              title="Editing"
              aria-label="Editing mode"
              :aria-pressed="!packed"
              @click="packed = false"
            >
              <Backpack :size="16" :stroke-width="2" />
            </button>
            <button
              type="button"
              class="modetoggle__opt"
              :class="{ 'is-active': packed }"
              title="Packing"
              aria-label="Packing mode"
              :aria-pressed="packed"
              @click="packed = true"
            >
              <SquareCheck :size="16" :stroke-width="2" />
            </button>
          </div>
          <button
            class="btn btn--icon btn--ghost editor__share"
            title="Copy read-only link"
            aria-label="Share — copy read-only link"
            @click="copyShare"
          >
            <Share2 :size="16" />
          </button>
          <div ref="menuRef" class="menu">
            <!-- a custom popover of real <button>s (was a native <select>): the
                 clipboard items need a direct click gesture, which a <select> change
                 isn't on iOS Safari. The kebab toggles it; each item runs on click. -->
            <button
              type="button"
              class="btn btn--icon btn--ghost menu__btn"
              aria-label="More actions"
              aria-haspopup="true"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >
              <Ellipsis :size="16" />
            </button>
            <Transition name="menu">
              <ul v-if="menuOpen" class="panel menu__list" role="menu" aria-label="More actions">
                <li role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="runMenu('duplicate')">Duplicate this list</button>
                </li>
                <li role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="runMenu('import')">Import a list…</button>
                </li>
                <li role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="runMenu('markdown')">Copy as Markdown</button>
                </li>
                <li role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="runMenu('csv')">Download CSV</button>
                </li>
                <li role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="runMenu('json')">Download JSON (backup)</button>
                </li>
                <li role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="runMenu('editlink')">Copy edit link…</button>
                </li>
                <li role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="runMenu('rotate')">Rotate edit link…</button>
                </li>
              </ul>
            </Transition>
          </div>
        </template>
      </div>
    </header>

    <main v-if="snapshot && totals" class="wrap editor__body">
      <TotalsBar
        :list="snapshot"
        :totals="totals"
        @set-unit="(u) => c.setUnit(u)"
      />
      <div class="editor__folders">
        <FolderSection
          v-for="f in sortedFolders"
          :key="f.id"
          :list="snapshot"
          :folder="f"
          :items="itemsByFolder.get(f.id) ?? NO_ITEMS"
          :packed="packed"
        />
      </div>
      <section v-if="ungrouped.length" class="panel editor__ungrouped">
        <p class="t-label">Ungrouped</p>
        <ItemRow v-for="it in ungrouped" :key="it.id" :list="snapshot" :item="it" :packed="packed" />
      </section>

      <div v-if="!packed" class="editor__addfolder">
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

    <main v-else-if="status === 'missing'" class="wrap editor__missing">
      <p class="t-muted">This list isn’t in this browser, or the link is invalid.</p>
      <button class="btn btn--primary" @click="newList">Start a new list</button>
    </main>

    <main v-else class="wrap editor__missing">
      <p class="t-muted">Loading…</p>
    </main>

    <SiteFooter />

    <Transition name="toast">
      <div v-if="pendingUndo" class="toast undobar">
        <span class="t-sm">Removed <strong>{{ pendingUndo.label }}</strong></span>
        <button class="undobar__btn t-sm" @click="c.undoRemove()">
          <Undo2 :size="14" /> Undo
        </button>
      </div>
      <div v-else-if="toast" class="toast t-sm">{{ toast }}</div>
    </Transition>

    <CatalogCorrectionModal @done="onCorrected" />
    <ImportModal :open="importOpen" @close="importOpen = false" />
  </div>
</template>

<style scoped>
/* column shell so the slim legal footer pins to the bottom on the short
   (empty / missing) states and sits below the list on long ones */
.editor {
  display: flex;
  flex-direction: column;
  min-height: 100svh;
}
.editor > main {
  flex: 1 0 auto;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}
.topbar__inner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-block: var(--space-3);
}
/* the list name is the toolbar's heading; the save state sits quietly beside it,
   on the same line so the title stays vertically centred with the app-bar icons
   (a stacked second line pushed the title above centre) */
/* flex:1 so the title group always fills the space up to the icon cluster — the
   transient "Saving…" status then changes width WITHIN this box (the title
   ellipsizes) instead of growing the group and nudging the app-bar icons on every
   save. */
.editor__titlewrap {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.editor__title {
  /* size to the title text (progressive enhancement; falls back to default
     input width where unsupported) */
  width: auto;
  field-sizing: content;
  min-width: 8ch;
  max-width: min(46ch, 42vw);
  font-family: var(--font);
  font-size: 1rem; /* static 16px — avoid iOS focus-zoom (see .field in controls.scss) */
  font-weight: 600;
  border-bottom-color: transparent;
  /* a long name that exceeds max-width truncates with an ellipsis at rest
     (the input still scrolls to the caret while you're editing it) */
  text-overflow: ellipsis;
}
@media (max-width: 560px) {
  /* let the title shrink past its content width so it ellipsizes instead of
     pushing the save status + app-bar controls off the edge */
  .editor__title {
    min-width: 0;
    /* drop the 42vw cap here: the flex layout (titlewrap flex:1 + this min-width:0)
       already bounds the title and ellipsizes it, so the cap just stranded usable
       space — let the name run right up to the status + icon cluster */
    max-width: none;
  }
}
.editor__title:focus {
  border-bottom-color: var(--accent);
}
/* save status as plain text beside the title — no icon, no pill, no colour. On
   one line (flex:none, nowrap) it shares the title's line box, so it appears &
   vanishes between saves without ever changing the header height (no reflow). */
.editor__status {
  flex: none;
  color: var(--ink-2);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.editor__status[data-state="error"] {
  color: var(--ink);
}
/* offline is informational, not an alarm — sits quietly, dimmer than the error cue */
.editor__status[data-state="offline"] {
  color: var(--ink-3);
}
/* the icon cluster is rigid (flex:none) and pinned to the trailing edge by the
   title group's flex:1 — so the transient "Saving…" status is absorbed by the
   title (it ellipsizes) and never nudges these icons on a flush. */
.editor__share,
.menu {
  flex: none;
}
/* editing/packing toggle — a light container with two icon options + a tracking pill */
.modetoggle {
  position: relative;
  flex: none;
  display: inline-flex;
  gap: var(--space-px);
  padding: var(--space-px);
  background: var(--paper-2);
  border-radius: var(--radius-pill);
}
/* the active tint lives on ONE pill that slides between segments (was a per-segment
   background crossfade). width/translate are percentage-based so it tracks the wider
   coarse-pointer segments too. damped --ease — overshoot would let it leave the track. */
.modetoggle__pill {
  position: absolute;
  top: var(--space-px);
  bottom: var(--space-px);
  left: var(--space-px);
  width: calc((100% - 3 * var(--space-px)) / 2); /* one segment: (inner − gap) / 2 */
  border-radius: var(--radius-pill);
  background: color-mix(in oklab, var(--ink) 12%, transparent);
  pointer-events: none;
  transition: transform var(--dur) var(--ease);
  will-change: transform;
}
.modetoggle__pill.is-packing {
  transform: translateX(calc(100% + var(--space-px))); /* over segment 2: own width + gap */
}
.modetoggle__opt {
  position: relative; /* sits above the pill */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 28px;
  border-radius: var(--radius-pill);
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.modetoggle__opt:hover {
  color: var(--ink-2);
}
.modetoggle__opt.is-active {
  color: var(--ink);
}
/* touch: each segment becomes a proper tap target (matches the 44px icon buttons) */
@media (pointer: coarse) {
  .modetoggle__opt {
    width: 44px;
    height: 40px;
  }
  .modetoggle__opt svg {
    width: 18px;
    height: 18px;
  }
}
.editor__share {
  color: var(--ink-2);
}
/* the kebab is the trigger; it toggles a custom popover (.menu__list) anchored to it.
   relative so the absolute popover anchors here. */
.menu {
  position: relative;
  display: inline-flex;
  /* shift the whole trailing cluster (toggle · share · kebab) right into the
     gutter so the kebab lines up with the item rows' drag handle below — and the
     toggle + share move over with it. The title group (flex:1) absorbs the freed
     space, so this reflows the cluster as a unit (no tap-target overlap). */
  margin-right: -13px;
}
.menu__btn {
  color: var(--ink-2);
}
/* the dropdown — a floating .panel (paper-2 + hairline + radius-2) anchored under the
   kebab, right-aligned to it and the toolbar gutter. Items are real <button>s so the
   clipboard actions fire from a click (a <select> change isn't a clipboard gesture on
   iOS Safari). */
.menu__list {
  position: absolute;
  top: calc(100% + var(--space-1));
  right: 0;
  z-index: 20;
  min-width: 12rem;
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  box-shadow: var(--shadow-pop);
  transform-origin: top right;
}
.menu__item {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-1);
  background: none;
  color: var(--ink);
  font-size: var(--text-base);
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.menu__item:hover,
.menu__item:focus-visible {
  background: color-mix(in oklab, var(--ink) 8%, transparent);
  outline: none;
}
/* pops in from the kebab corner: quick fade + slight rise, spring on enter */
.menu-enter-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease-spring);
}
.menu-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.98);
}
.editor__body {
  /* no bottom padding: the footer's margin-top is the single content→footer gap
     (matches the inter-folder rhythm), so it isn't doubled up here */
  padding-block: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.editor__folders {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
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
.editor__ungrouped .t-label {
  margin-bottom: var(--space-2);
}
/* reads like a folder heading — same type as a folder name, dimmer, flush-left
   with the folder names above it. Tapping it swaps the label for an inline text
   field. */
.editor__addfolder {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  /* sit a full folder-gap below the last folder: the body gap is --space-4, so add
     the remainder to reach --space-7, matching the folder-to-folder rhythm */
  margin-top: calc(var(--space-7) - var(--space-4));
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
  letter-spacing: -0.02em;
}
.editor__addfolderbtn {
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.editor__addfolderbtn:hover {
  color: var(--ink-2);
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
.toast {
  position: fixed;
  left: 50%;
  bottom: var(--space-5);
  /* translate(-50%, 0) — NOT translateX(-50%) — so the resting transform is the SAME
     function as the enter/leave states' translate(-50%, Ypx). iOS Safari won't animate
     across mismatched transform functions (translateX → translate); Chromium will
     (matrix interpolation), which masked this. */
  transform: translate(-50%, 0);
  /* a position:fixed box is laid out against the viewport, so it escapes the
     html{overflow-x:clip} guard; without a cap, translateX(-50%) of a wide toast
     could overhang an edge and (like any element wider than the layout viewport)
     nudge iOS Safari into the same viewport-growth margin bug. Keep it within the
     gutters. */
  max-width: calc(100% - 2 * var(--space-4));
  background: var(--ink);
  color: var(--paper);
  padding: var(--space-2) var(--space-4);
  /* gently rounded — softens the square slab without going full pill */
  border-radius: var(--radius-2);
}
.undobar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.undobar__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  background: none;
  border: 0;
  color: var(--paper);
  font-weight: 600;
  /* soft underline, matching the site's --underline house style — but the toast is
     inverted (paper text on ink), so soften the PAPER rather than using --ink-3
     (which would vanish on the dark toast). Translucent paper stays legible + quiet. */
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--paper) 55%, transparent);
  text-underline-offset: 2px;
  cursor: pointer;
}
/* enter ≠ exit: it arrives with a livelier spring rise (the toast is the event), and
   leaves quietly on the plain ease. both keep translate(-50%, …) — the toast is
   X-centred, so the overshoot only plays on Y (both ends share X = -50%). */
.toast-enter-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease-spring);
}
.toast-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.toast-enter-from {
  opacity: 0;
  transform: translate(-50%, 12px);
}
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
