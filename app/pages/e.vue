<script setup lang="ts">
import { ArrowLeft, Ellipsis, Undo2 } from "@lucide/vue";
import { listToMarkdown } from "~~/shared/exporters/markdown";
import { listToCsv } from "~~/shared/exporters/csv";
import { listToSummary } from "~~/shared/exporters/summary";

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
function copySummary() {
  menuOpen.value = false;
  if (snapshot.value)
    copy(listToSummary(snapshot.value, `${origin()}/s/${snapshot.value.shareCode}`), "Summary copied");
}
async function cloneList() {
  menuOpen.value = false;
  if (!snapshot.value) return;
  // fresh ids so the copy is fully independent; keep folder→item links + notes/weights
  const newId = () =>
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(performance.now())}`;
  const idMap = new Map<string, string>();
  const folders = snapshot.value.folders.map((f) => {
    const nid = newId();
    idMap.set(f.id, nid);
    return { ...f, id: nid };
  });
  const items = snapshot.value.items.map((i) => ({
    ...i,
    id: newId(),
    folderId: i.folderId ? (idMap.get(i.folderId) ?? null) : null,
    packed: false,
  }));
  const res = await $fetch<{ editToken: string; snapshot: any }>("/api/lists/create", {
    method: "POST",
    body: { title: `${snapshot.value.title || "Untitled list"} (copy)`, data: { folders, items } },
  });
  useMyLists().upsert({
    editToken: res.editToken,
    shareCode: res.snapshot.shareCode,
    slug: res.snapshot.slug,
    title: res.snapshot.title,
    totalMg: totals.value?.totalMg ?? 0,
    version: res.snapshot.version,
    lastOpened: Date.now(),
  });
  router.push(`/e#${res.editToken}`);
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

async function newList() {
  const res = await $fetch<{ editToken: string; snapshot: any }>("/api/lists/create", {
    method: "POST",
    body: { title: "Untitled list", data: { folders: [], items: [] } },
  });
  useMyLists().upsert({
    editToken: res.editToken, shareCode: res.snapshot.shareCode, slug: res.snapshot.slug,
    title: res.snapshot.title, totalMg: 0, version: res.snapshot.version, lastOpened: Date.now(),
  });
  // the route.hash watcher disposes + loads — don't double-load here
  router.push(`/e#${res.editToken}`);
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
        <NuxtLink to="/" class="btn btn--sm btn--ghost"><ArrowLeft :size="15" /> Lists</NuxtLink>
        <input
          v-if="snapshot"
          class="field editor__title"
          :value="snapshot.title"
          placeholder="Untitled list"
          @change="c.setMeta({ title: ($event.target as HTMLInputElement).value })"
        />
        <span v-if="snapshot && statusLabel" class="savechip" :data-state="status">
          <i class="savechip__dot" />{{ statusLabel }}
        </span>
        <template v-if="snapshot">
          <button class="btn btn--sm btn--primary editor__share" @click="copyShare">Share</button>
          <div ref="menuRef" class="menu">
            <button class="btn btn--sm btn--ghost btn--icon" aria-haspopup="true" aria-label="More actions" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen"><Ellipsis :size="16" /></button>
            <ul v-if="menuOpen" class="menu__list panel">
              <li><button @click="cloneList">Duplicate this list</button></li>
              <li><button @click="copyMarkdown">Copy as Markdown</button></li>
              <li><button @click="copySummary">Copy summary</button></li>
              <li><button @click="downloadCsv">Download CSV</button></li>
              <li><button @click="downloadJson">Download JSON (backup)</button></li>
              <li><button @click="copyEditLink">Copy edit link…</button></li>
              <li><button @click="rotate">Rotate edit link…</button></li>
              <li><NuxtLink to="/changes" @click="menuOpen = false">Recent catalog changes</NuxtLink></li>
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

      <button v-if="!packed" class="btn editor__addfolder" @click="c.addFolder()">+ Add folder</button>
    </main>

    <main v-else-if="status === 'missing'" class="wrap editor__missing">
      <p class="t-muted">This list isn’t in this browser, or the link is invalid.</p>
      <button class="btn btn--primary" @click="newList">Start a new list</button>
    </main>

    <main v-else class="wrap editor__missing">
      <p class="t-muted">Loading…</p>
    </main>

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
  </div>
</template>

<style scoped>
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
  padding-block: var(--space-2);
}
.editor__title {
  flex: 0 1 auto;
  /* size to the title text so the Saved chip hugs the name (progressive
     enhancement; falls back to default input width where unsupported) */
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
/* small "Saved" chip hugging the title; actions get pushed to the right */
.savechip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-2);
  background: var(--paper-3);
  color: var(--ink-2);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.savechip__dot {
  width: 5px;
  height: 5px;
  background: var(--ink-3);
}
.savechip[data-state="synced"] .savechip__dot {
  background: var(--ink);
}
.savechip[data-state="error"] {
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
  top: calc(100% + 4px);
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
/* load reveal: folders cascade in (SPACE10 signature), ~50ms apart */
.editor__folders > * {
  animation: rise var(--dur-slow) var(--ease) both;
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
}
.editor__missing {
  padding-block: var(--space-9);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
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
