<script setup lang="ts">
import { Ellipsis, Undo2 } from "@lucide/vue";
import { listToMarkdown } from "~~/shared/exporters/markdown";
import { listToCsv } from "~~/shared/exporters/csv";
import { uid } from "~~/shared/id";
import type { ListSnapshot } from "~~/shared/types";

// The editor is a focused app surface — it skips the marketing SiteFooter (the
// default layout) in favour of the slim legal line at the bottom of this view.
definePageMeta({ layout: false });

const c = useGearList();
const router = useRouter();

const snapshot = c.snapshot;
const totals = c.totals;
const status = c.status;
const pendingUndo = c.pendingUndo;
// items whose folder was removed (e.g. by a concurrent editor) land here, not as invisible ghosts
const ungrouped = computed(() =>
  snapshot.value ? snapshot.value.items.filter((i) => !i.folderId) : [],
);

const packed = ref(false);
const menuOpen = ref(false);
const importOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const route = useRoute();
// Drive load off the reactive hash so back/forward + same-route nav between two
// of your lists dispose+reload correctly (the editor singleton holds one list).
watch(
  () => route.hash,
  (h) => {
    c.dispose();
    const token = decodeURIComponent((h || "").replace(/^#/, ""));
    if (token) c.load(token);
    else c.status.value = "missing";
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  clearTimeout(toastTimer);
  c.dispose();
});

onClickOutside(menuRef, () => (menuOpen.value = false));
onKeyStroke("Escape", () => {
  if (menuOpen.value) menuOpen.value = false;
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

function copyShare() {
  if (snapshot.value) copy(`${origin()}/s/${snapshot.value.shareCode}`, "Read-only link copied");
}
function copyEditLink() {
  menuOpen.value = false;
  if (!confirm("Anyone with this link can edit your list. Only send it to people you trust.")) return;
  copy(`${origin()}/e#${c.editToken}`, "Edit link copied");
}
async function rotate() {
  menuOpen.value = false;
  if (!confirm("Make the old edit link stop working and create a new one?")) return;
  const next = await c.rotate();
  if (next) {
    history.replaceState(null, "", `/e#${next}`);
    flash("Edit link rotated");
  }
}
function copyMarkdown() {
  menuOpen.value = false;
  if (snapshot.value) copy(listToMarkdown(snapshot.value), "Copied as Markdown");
}
async function cloneList() {
  menuOpen.value = false;
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
  menuOpen.value = false;
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
  menuOpen.value = false;
  importOpen.value = true;
}

async function newList() {
  const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
    method: "POST",
    body: { title: "Untitled list", data: { folders: [], items: [] } },
  });
  // the route.hash watcher disposes + loads — don't double-load here
  router.push(`/e#${useMyLists().registerCreated(res)}`);
}

const statusLabel = computed(() =>
  ({ loading: "Loading…", saving: "Saving…", synced: "Saved", error: "Not saved ↻", missing: "", idle: "" })[status.value] || "",
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
  <div class="editor">
    <header class="topbar">
      <div class="wrap topbar__inner">
        <div v-if="snapshot" class="editor__titlewrap">
          <input
            class="field editor__title"
            :value="snapshot.title"
            placeholder="Untitled list"
            @change="c.setMeta({ title: ($event.target as HTMLInputElement).value })"
          />
          <span
            v-if="statusLabel"
            class="editor__status"
            :data-state="status"
            aria-live="polite"
          >{{ statusLabel }}</span>
        </div>
        <template v-if="snapshot">
          <button class="btn btn--sm btn--primary editor__share" @click="copyShare">Share</button>
          <div ref="menuRef" class="menu">
            <button class="btn btn--sm btn--ghost btn--icon" aria-haspopup="true" title="More actions" aria-label="More actions" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen"><Ellipsis :size="16" /></button>
            <ul v-if="menuOpen" class="menu__list panel">
              <li><button @click="cloneList">Duplicate this list</button></li>
              <li><button @click="openImport">Import a list…</button></li>
              <li><button @click="copyMarkdown">Copy as Markdown</button></li>
              <li><button @click="downloadCsv">Download CSV</button></li>
              <li><button @click="downloadJson">Download JSON (backup)</button></li>
              <li><button @click="copyEditLink">Copy edit link…</button></li>
              <li><button @click="rotate">Rotate edit link…</button></li>
            </ul>
          </div>
        </template>
      </div>
    </header>

    <main v-if="snapshot && totals" class="wrap editor__body">
      <TotalsBar
        :list="snapshot"
        :totals="totals"
        v-model:packed="packed"
        @set-unit="(u) => c.setUnit(u)"
      />
      <div class="editor__folders">
        <FolderSection
          v-for="f in snapshot.folders"
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

      <button v-if="!packed" class="btn editor__addfolder" @click="c.addFolder()">Add folder</button>
    </main>

    <main v-else-if="status === 'missing'" class="wrap editor__missing">
      <p class="t-muted">This list isn’t in this browser, or the link is invalid.</p>
      <button class="btn btn--primary" @click="newList">Start a new list</button>
    </main>

    <main v-else class="wrap editor__missing">
      <p class="t-muted">Loading…</p>
    </main>

    <footer class="wrap editor__legal">
      <NuxtLink to="/privacy" class="t-sm">Privacy</NuxtLink>
      <NuxtLink to="/terms" class="t-sm">Terms</NuxtLink>
      <span class="t-sm t-muted">© {{ new Date().getFullYear() }} Gear</span>
    </footer>

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
/* the list name is the toolbar's heading; the save state sits quietly beneath it */
.editor__titlewrap {
  flex: 0 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.editor__title {
  /* size to the title text (progressive enhancement; falls back to default
     input width where unsupported) */
  width: auto;
  field-sizing: content;
  min-width: 8ch;
  max-width: min(46ch, 42vw);
  font-family: var(--font);
  font-size: var(--text-title);
  border-bottom-color: transparent;
}
.editor__title:focus {
  border-bottom-color: var(--accent);
}
/* save status as plain text under the title — no icon, no pill, no colour */
.editor__status {
  color: var(--ink-2);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.editor__status[data-state="error"] {
  color: var(--ink);
}
.editor__share {
  margin-left: auto;
}
.menu {
  position: relative;
}
.menu__list {
  position: absolute;
  right: 0;
  top: calc(100% + var(--space-1));
  min-width: 180px;
  z-index: 20;
  padding: var(--space-1);
}
.menu__list button,
.menu__list a {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-1);
  font-size: var(--text-sm);
  color: var(--ink);
}
.menu__list button:hover,
.menu__list a:hover {
  background: var(--paper-3);
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
.editor__addfolder {
  align-self: flex-start;
  /* a quiet text affordance paired with "Add an item…": text aligns to the
     content left edge, no padded hover fill */
  padding-inline: 0;
  color: var(--ink-2);
}
.editor__addfolder:hover {
  background: transparent;
  color: var(--ink);
}
.editor__missing {
  padding-block: var(--space-9);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}
/* slim, quiet legal line — the app surface's stand-in for the marketing footer */
.editor__legal {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  padding-block: var(--space-5);
  border-top: 1px solid var(--line);
}
.editor__legal a {
  color: var(--ink-2);
  border-bottom: 1px solid transparent;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.editor__legal a:hover {
  color: var(--ink);
  border-bottom-color: var(--ink);
}
.editor__legal span {
  margin-left: auto;
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
