<script setup lang="ts">
import { Backpack, Ellipsis, Share2, SquareCheck, Undo2 } from "@lucide/vue";
import { listToMarkdown } from "~~/shared/exporters/markdown";
import { listToCsv } from "~~/shared/exporters/csv";
import { uid } from "~~/shared/id";
import type { ListSnapshot } from "~~/shared/types";
import { bySortOrder } from "~~/shared/weights";

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

const packed = ref(false);
const importOpen = ref(false);
const menuAction = ref("");
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

// "Add folder" becomes an inline text field on tap; it only creates the folder
// (and shows the next "Add folder") once you commit — enter or click away.
const addingFolder = ref(false);
const newFolderRef = ref<HTMLInputElement | null>(null);
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
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 300);
}
onMounted(() => window.addEventListener("focusin", onFocusIn));
onBeforeUnmount(() => {
  clearTimeout(focusScrollTimer);
  window.removeEventListener("focusin", onFocusIn);
});

function flash(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2000);
}
async function copy(text: string, msg: string) {
  try {
    await navigator.clipboard.writeText(text);
    flash(msg);
  } catch {
    flash("Copy failed");
  }
}
const origin = () => (typeof location !== "undefined" ? location.origin : "");

// the ⋯ actions menu is a native <select> (OS menu chrome on mobile + desktop):
// route the chosen option to its handler, then reset to the placeholder so the
// same action can be re-picked and the control shows "Actions…" again at rest.
function onMenuAction() {
  const action = menuAction.value;
  menuAction.value = "";
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
function downloadCsv() {
  if (!snapshot.value) return;
  download(`${snapshot.value.slug || "gear"}.csv`, listToCsv(snapshot.value), "text/csv");
  flash("CSV downloaded");
}
function downloadJson() {
  if (!snapshot.value) return;
  const { title, description, displayUnit, folders, items } = snapshot.value;
  download(
    `${snapshot.value.slug || "gear"}.json`,
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

// no steady-state "Saved" noise — only transient saving / error / loading shows
const statusLabel = computed(() =>
  ({ loading: "Loading…", saving: "Saving…", synced: "", error: "Not saved ↻", missing: "", idle: "" })[status.value] || "",
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
          <div class="menu">
            <!-- the kebab is the visible trigger; a transparent native <select>
                 sits on top of it (same pattern as the row's classification
                 control), so a tap opens OS menu chrome — the system sheet/picker
                 on mobile, the native dropdown on desktop. -->
            <button
              type="button"
              class="btn btn--icon btn--ghost menu__btn"
              tabindex="-1"
              aria-hidden="true"
            >
              <Ellipsis :size="16" />
            </button>
            <select
              v-model="menuAction"
              class="menu__select"
              aria-label="More actions"
              @change="onMenuAction"
            >
              <option value="">Actions…</option>
              <option value="duplicate">Duplicate this list</option>
              <option value="import">Import a list…</option>
              <option value="markdown">Copy as Markdown</option>
              <option value="csv">Download CSV</option>
              <option value="json">Download JSON (backup)</option>
              <option value="editlink">Copy edit link…</option>
              <option value="rotate">Rotate edit link…</option>
            </select>
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
.editor__titlewrap {
  flex: 0 1 auto;
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
  font-size: var(--text-base);
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
/* editing/packing toggle — a light container with two icon options */
.modetoggle {
  margin-left: auto;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--paper-2);
  border-radius: var(--radius-pill);
}
.modetoggle__opt {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 28px;
  border-radius: var(--radius-pill);
  color: var(--ink-3);
  cursor: pointer;
  transition:
    color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.modetoggle__opt:hover {
  color: var(--ink-2);
}
.modetoggle__opt.is-active {
  /* a mode-adaptive tint so the active option stands out on both themes */
  background: color-mix(in oklab, var(--ink) 12%, transparent);
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
/* the kebab icon is the visible trigger; a transparent native <select> sits on
   top of it (same pattern as the row's classification control) so a tap opens OS
   menu chrome — the system sheet/picker on mobile, the native dropdown on desktop.
   the disclosure arrow + the open list are the platform's own. */
.menu {
  position: relative;
  display: inline-flex;
}
.menu__btn {
  color: var(--ink-2);
  /* purely decorative — the overlaid <select> is the real control */
  pointer-events: none;
}
.menu__select {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
}
.editor__body {
  padding-block: var(--space-4) var(--space-9);
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
.editor__folders > *:nth-child(2) {
  animation-delay: 50ms;
}
.editor__folders > *:nth-child(3) {
  animation-delay: 100ms;
}
.editor__folders > *:nth-child(4) {
  animation-delay: 150ms;
}
.editor__folders > *:nth-child(5) {
  animation-delay: 200ms;
}
.editor__folders > *:nth-child(n + 6) {
  animation-delay: 250ms;
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
  transform: translateX(-50%);
  background: var(--ink);
  color: var(--paper);
  padding: var(--space-2) var(--space-4);
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
  text-decoration: underline;
  cursor: pointer;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
