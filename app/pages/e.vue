<script setup lang="ts">
import { listToMarkdown } from "~~/shared/exporters/markdown";
import { listToCsv } from "~~/shared/exporters/csv";

const c = useGearList();
const router = useRouter();

const snapshot = c.snapshot;
const totals = c.totals;
const status = c.status;
// items whose folder was removed (e.g. by a concurrent editor) land here, not as invisible ghosts
const ungrouped = computed(() =>
  snapshot.value ? snapshot.value.items.filter((i) => !i.folderId) : [],
);

const showBreakdown = ref(false);
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
</script>

<template>
  <div class="editor">
    <header class="topbar">
      <div class="wrap topbar__inner">
        <NuxtLink to="/" class="btn btn--sm btn--ghost">← Lists</NuxtLink>
        <input
          v-if="snapshot"
          class="field editor__title"
          :value="snapshot.title"
          placeholder="Untitled list"
          @change="c.setMeta({ title: ($event.target as HTMLInputElement).value })"
        />
        <span v-if="snapshot" class="t-xs t-faint editor__status">{{ statusLabel }}</span>
        <template v-if="snapshot">
          <button class="btn btn--sm btn--primary" @click="copyShare">Share</button>
          <div ref="menuRef" class="menu">
            <button class="btn btn--sm btn--ghost" aria-haspopup="true" aria-label="More actions" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">⋯</button>
            <ul v-if="menuOpen" class="menu__list panel">
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
        v-model:show-breakdown="showBreakdown"
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
      <p class="t-faint">Loading…</p>
    </main>

    <Transition name="toast">
      <div v-if="toast" class="toast t-sm">{{ toast }}</div>
    </Transition>
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
  flex: 1;
  min-width: 0;
  font-family: var(--font-serif);
  font-size: var(--text-title);
  border-bottom-color: transparent;
}
.editor__title:focus {
  border-bottom-color: var(--accent);
}
.editor__status {
  flex: none;
  min-width: 48px;
  text-align: right;
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
.menu__list button {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}
.menu__list button:hover {
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
