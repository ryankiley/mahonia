<script setup lang="ts">
import {
  ArrowDown10,
  ArrowDownAZ,
  ArrowDownUp,
  ArrowUp01,
  ChevronDown,
  CircleX,
  Folder as FolderIcon,
  GripVertical,
  Trash2,
  Undo2,
  Vault,
} from "@lucide/vue";
import type { Unit } from "~~/shared/types";
import type { VaultEntry, VaultFolder } from "~~/shared/vault";
import { formatWeightAuto, itemDisplayName } from "~~/shared/weights";

// The vault — every piece of gear you've put in a list, in one place, so building
// the next list is picking rather than retyping.
//
// Owned by your ACCOUNT — the one part of Mahonia that asks you to sign in. Lists
// stay link-owned and always will; a vault is different because it's the durable
// record of what you own, and the thing you'd most hate to lose to a cleared
// browser. Signing in on another device is what carrying it there means now.
//
// noindex: it's one person's possessions and there is nothing here for a crawler.
useHead({
  title: "Gear vault — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

const { hasVault, vaultFetch } = useVaultAccess();
const { confirm: askConfirm } = useDialogs();

// ---- the gear ------------------------------------------------------------
const items = ref<VaultEntry[]>([]);
// What "Remove" put away. Capture never resurrects a tombstoned row — that's what
// stops every list still holding the gear from undoing your removal — so without
// somewhere to see them, removal would be permanent past the undo toast's few
// seconds. This is the way back, and it's deliberate rather than guessed.
const removed = ref<VaultEntry[]>([]);
const folders = ref<VaultFolder[]>([]);
const showRemoved = ref(false);
const loading = ref(false);
const loadError = ref("");
const query = ref("");
const searchEl = useTemplateRef<HTMLInputElement>("searchEl");
// clearing returns you to the field, not to nowhere — you cleared it to type again
function clearQuery() {
  query.value = "";
  searchEl.value?.focus();
}

async function loadVault() {
  if (!hasVault.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    const res = await vaultFetch<{
      items: VaultEntry[];
      removed: VaultEntry[];
      folders: VaultFolder[];
    }>("/api/vault/list");
    items.value = res.items || [];
    removed.value = res.removed || [];
    folders.value = res.folders || [];
  } catch {
    loadError.value = "Couldn’t load your gear vault. Check your connection and try again.";
  }
  loading.value = false;
}
// load once we know whether there's a vault to load, and again when that flips —
// signing in or out mid-session, which the session plugin's watcher drives
watch(
  hasVault,
  (v) => {
    if (v) return void loadVault();
    items.value = [];
    removed.value = [];
    folders.value = [];
  },
  { immediate: true },
);

// Put a removed piece of gear back. Same endpoint the undo toast uses — restoring
// is restoring, whether you do it two seconds later or two months.
async function putBack(entry: VaultEntry) {
  restoring.value = entry.id;
  loadError.value = "";
  try {
    await vaultFetch("/api/vault/remove", { method: "POST", body: { id: entry.id, restore: true } });
    await loadVault();
  } catch {
    loadError.value = "Couldn’t put that back. Check your connection and try again.";
  }
  restoring.value = null;
}
const restoring = ref<number | null>(null);

// Plain substring filter, not the trigram ranker: this is a list you're LOOKING
// at, so narrowing it should be literal and predictable. Fuzzy matching belongs in
// the autocomplete, where you're typing a name you can't quite remember.
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((i) =>
    `${i.brand ?? ""} ${i.name} ${i.variant ?? ""} ${i.commonName ?? ""}`.toLowerCase().includes(q),
  );
});

const totalMg = computed(() => filtered.value.reduce((sum, i) => sum + i.weightMg, 0));

// ---- folders -------------------------------------------------------------
// The page renders one section per folder, in the holder's drag order, with
// everything unfiled last. Searching flattens the grouping: a query is a question
// about the whole vault, and answering it inside twelve headings (most of them
// empty) buries the handful of rows that matched.
const grouped = computed(() => {
  const byFolder = new Map<number | null, VaultEntry[]>();
  for (const entry of filtered.value) {
    const key = entry.folderId ?? null;
    const bucket = byFolder.get(key);
    if (bucket) bucket.push(entry);
    else byFolder.set(key, [entry]);
  }
  const sections: { folder: VaultFolder | null; entries: VaultEntry[] }[] = folders.value
    .map((f) => ({ folder: f as VaultFolder | null, entries: sortEntries(byFolder.get(f.id) ?? [], f.sortBy) }))
    // an empty folder still shows: it's a heading you made, and hiding it would
    // make "delete" the only way to be rid of one you no longer want
    .concat(
      byFolder.has(null)
        ? [{ folder: null, entries: sortEntries(byFolder.get(null)!, undefined) }]
        : [],
    );
  return sections;
});

// The per-folder item order, matching the editor's FolderSort verbs so the two
// surfaces sort the same way. "manual" here means the vault's own default —
// most-recently-used first, which is the order the server already returns.
function sortEntries(entries: VaultEntry[], sortBy: VaultFolder["sortBy"]): VaultEntry[] {
  if (!sortBy || sortBy === "manual") return entries;
  const copy = [...entries];
  if (sortBy === "name") {
    return copy.sort((a, b) =>
      itemDisplayName(a.brand, a.name, a.variant).localeCompare(
        itemDisplayName(b.brand, b.name, b.variant),
      ),
    );
  }
  return copy.sort((a, b) => (sortBy === "heaviest" ? b.weightMg - a.weightMg : a.weightMg - b.weightMg));
}

// Collapse, the same mechanism the editor's folders use: persisted per folder id so
// a collapsed folder stays collapsed across reloads, and never sent to the server —
// it's how YOU are looking at the vault, not a fact about the gear. Keyed under
// gear.vfold.* rather than the editor's gear.fold.* because a vault folder id (an
// integer) and a list folder id (a uuid) share a namespace otherwise.
const collapsed = ref<Record<number, boolean>>({});
onMounted(() => {
  for (const f of folders.value) readCollapsed(f.id);
});
watch(folders, (list) => list.forEach((f) => readCollapsed(f.id)));
function readCollapsed(id: number) {
  try {
    collapsed.value[id] = localStorage.getItem(`gear.vfold.${id}`) === "1";
  } catch {
    /* private mode / no storage — default expanded */
  }
}
function toggleCollapsed(id: number) {
  const next = !collapsed.value[id];
  collapsed.value[id] = next;
  try {
    localStorage.setItem(`gear.vfold.${id}`, next ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// the editor's SORT_META verbatim — same glyph family, same labels, so a folder
// sorted "Heaviest first" reads identically on both surfaces
type VaultSort = NonNullable<VaultFolder["sortBy"]>;
const SORT_META: Record<VaultSort, { label: string; icon: typeof ArrowDownUp }> = {
  manual: { label: "Manual order", icon: ArrowDownUp },
  name: { label: "Name (A–Z)", icon: ArrowDownAZ },
  heaviest: { label: "Heaviest first", icon: ArrowDown10 },
  lightest: { label: "Lightest first", icon: ArrowUp01 },
};
const SORT_ORDER: VaultSort[] = ["manual", "name", "heaviest", "lightest"];

// Every folder change goes through the one ops route, then reloads — a vault is a
// hundred rows and one small read, so re-reading is simpler and never leaves the
// page disagreeing with the server about an order or a filing.
async function folderOp(op: Record<string, unknown>) {
  loadError.value = "";
  try {
    await vaultFetch("/api/vault/folders", { method: "POST", body: { op } });
    await loadVault();
  } catch {
    loadError.value = "Couldn’t save that change. Check your connection and try again.";
  }
}
// Drag a folder to reorder it — the editor's gesture, on the shared
// createPointerDrag scaffold (capture, Escape/cancel, the text-selection lock). The
// editor's useFolderDnd itself can't be reused: it's a singleton bound to
// useGearList's op reducer, and a vault folder is a row behind a REST call.
const draggingFolder = ref<number | null>(null);
const folderDrop = ref<number | null>(null);
const folderDrag = createPointerDrag<number>({
  track(ev, el) {
    const over = el?.closest("[data-vault-folder]") as HTMLElement | null;
    const id = Number(over?.getAttribute("data-vault-folder"));
    // above the first / below the last, or over the unfiled heading (which has no
    // id): keep the last target so the indicator doesn't flicker mid-drag
    if (!id) return;
    folderDrop.value = id;
  },
  target: () => folderDrop.value,
  commit: (dragId, overId) => {
    const ids = folders.value.map((f) => f.id);
    const from = ids.indexOf(Number(dragId));
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void folderOp({ t: "reorder", ids });
  },
  onStart() {
    folderDrop.value = null;
  },
  onReset() {
    draggingFolder.value = null;
    folderDrop.value = null;
  },
  within: ".vault__page",
});
function startFolderDrag(id: number, ev: PointerEvent) {
  draggingFolder.value = id;
  folderDrag.start(String(id), ev);
}

// Drag a piece of gear into another folder. Same scaffold, a separate gesture: a
// folder drag reorders headings, this one re-files a row, and one `track` trying to
// mean both would have to guess from the grab point which you meant.
//
// The drop target is the FOLDER, not a slot within it: a vault folder's order is
// its sortBy, so there is no position to aim at — unlike the list, where dropping
// between two rows is the whole point.
const draggingItem = ref<number | null>(null);
// number = a folder, null = unfiled, undefined = not over a drop target
const itemDrop = ref<number | null | undefined>(undefined);
const itemDrag = createPointerDrag<number | null>({
  track(ev, el) {
    const over = el?.closest("[data-vault-folder]") as HTMLElement | null;
    // off every section (the page margins, the header) — hold the last target so a
    // wobble mid-drag doesn't drop the indicator
    if (!over) return;
    const attr = over.getAttribute("data-vault-folder");
    itemDrop.value = attr ? Number(attr) : null; // "" is the unfiled section
  },
  target: () => (itemDrop.value === undefined ? null : itemDrop.value),
  commit: (dragId, folderId) => {
    const itemId = Number(dragId);
    const from = items.value.find((i) => i.id === itemId)?.folderId ?? null;
    if (from === folderId) return; // dropped where it already was
    void folderOp({ t: "move", itemId, folderId });
  },
  onStart() {
    itemDrop.value = undefined;
  },
  onReset() {
    draggingItem.value = null;
    itemDrop.value = undefined;
  },
  within: ".vault__page",
});
// Grab a row anywhere — unlike the pane's rows these aren't click targets, so
// there's nothing to tell the gesture apart from and no handle to add. A small
// travel threshold still separates a drag from a stray press, and a press that
// starts on a control (the folder picker, the bin) is left alone.
const DRAG_THRESHOLD = 5;
let rowPress: { x: number; y: number; pointerId: number; id: number } | null = null;
function endRowPress() {
  rowPress = null;
  window.removeEventListener("pointermove", onRowPressMove);
  window.removeEventListener("pointerup", endRowPress);
  window.removeEventListener("pointercancel", endRowPress);
}
function onRowPressMove(ev: PointerEvent) {
  if (!rowPress || ev.pointerId !== rowPress.pointerId) return;
  if (Math.hypot(ev.clientX - rowPress.x, ev.clientY - rowPress.y) < DRAG_THRESHOLD) return;
  const id = rowPress.id;
  endRowPress();
  startItemDrag(id, ev);
}
function onRowPointerDown(id: number, ev: PointerEvent) {
  if (ev.button !== 0) return;
  // a select or a button owns its own press
  if ((ev.target as HTMLElement).closest("select, button")) return;
  endRowPress();
  rowPress = { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, id };
  window.addEventListener("pointermove", onRowPressMove);
  window.addEventListener("pointerup", endRowPress);
  window.addEventListener("pointercancel", endRowPress);
}
onBeforeUnmount(endRowPress);

function startItemDrag(id: number, ev: PointerEvent) {
  draggingItem.value = id;
  itemDrag.start(String(id), ev);
}

const newFolder = ref("");
function addFolder() {
  const name = newFolder.value.trim();
  if (!name) return;
  newFolder.value = "";
  void folderOp({ t: "add", name });
}
function renameFolder(f: VaultFolder, e: Event) {
  const name = (e.target as HTMLInputElement).value.trim();
  if (!name || name === f.name) return;
  void folderOp({ t: "rename", id: f.id, name });
}
async function deleteFolder(f: VaultFolder) {
  const held = filtered.value.filter((i) => i.folderId === f.id).length;
  if (
    !(await askConfirm({
      title: `Delete “${f.name}”?`,
      message: held
        ? `The ${held} ${held === 1 ? "piece" : "pieces"} of gear in it stay in your gear vault — they just won’t be filed under anything.`
        : "The folder goes; nothing else changes.",
      confirmLabel: "Delete folder",
    }))
  )
    return;
  void folderOp({ t: "remove", id: f.id });
}

// ---- units ---------------------------------------------------------------
// The vault has no list to inherit a unit from, so it takes its default from the
// most recent list on this device (whatever system you already work in) and
// remembers an explicit choice from there.
const UNIT_KEY = "gear.vault.system.v1";
const system = ref<"metric" | "imperial">("metric");
onMounted(() => {
  const saved = localStorage.getItem(UNIT_KEY);
  if (saved === "metric" || saved === "imperial") {
    system.value = saved;
    return;
  }
  const recent = [...useMyLists().entries.value].sort((a, b) => b.lastOpened - a.lastOpened)[0];
  system.value = unitSystem(recent?.displayUnit);
});
function unitSystem(u?: Unit): "metric" | "imperial" {
  return u === "oz" || u === "lb" ? "imperial" : "metric";
}
function setSystem(next: "metric" | "imperial") {
  system.value = next;
  try {
    localStorage.setItem(UNIT_KEY, next);
  } catch {
    // storage blocked — the choice still holds for this visit
  }
}
const weightLabel = (mg: number) => formatWeightAuto(mg, { system: system.value });

// ---- remove + undo -------------------------------------------------------
// No confirm dialog: removing gear is small, reversible, and something you'd do
// several times in a row while tidying. An immediate removal with an undo beats a
// modal per row. (Deleting a whole LIST keeps its dialog — that one isn't
// reversible.)
const removing = ref<number | null>(null);
const undoable = ref<VaultEntry | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | undefined;

async function remove(entry: VaultEntry) {
  removing.value = entry.id;
  loadError.value = "";
  try {
    await vaultFetch("/api/vault/remove", { method: "POST", body: { id: entry.id } });
    items.value = items.value.filter((i) => i.id !== entry.id);
    undoable.value = entry;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (undoable.value = null), 10_000);
  } catch {
    loadError.value = "Couldn’t remove that. Check your connection and try again.";
  }
  removing.value = null;
}

async function undoRemove() {
  const entry = undoable.value;
  if (!entry) return;
  undoable.value = null;
  clearTimeout(undoTimer);
  try {
    await vaultFetch("/api/vault/remove", { method: "POST", body: { id: entry.id, restore: true } });
    await loadVault();
  } catch {
    loadError.value = "Couldn’t put that back. Check your connection and try again.";
  }
}
onBeforeUnmount(() => clearTimeout(undoTimer));

</script>

<template>
  <div>
    <SiteTopbar label="Gear vault">
      <NuxtLink to="/e" class="btn btn--link">Create a list</NuxtLink>
    </SiteTopbar>

    <main id="main-content" tabindex="-1" class="wrap page vault__page">
      <!-- The sentence IS the heading. "Gear vault" was being said twice — once
           here and once in the top bar's label — and of the two this is the one
           that tells you something. Still an h1, so the page keeps exactly one and
           the document outline is intact; the bar carries the page's name. -->
      <div class="vault__head">
        <h1 class="t-title vault__sub">Every piece of gear you’ve put in a list, in one place.</h1>
      </div>

      <ClientOnly>

        <!-- Signed out. The subtitle above already says what a vault IS, so this
             only has to answer the question that subtitle raises — why this one
             thing wants an account — and get out of the way. Lists are named
             because that's the promise people came for, and this page must not
             read as it being withdrawn. -->
        <div v-if="!hasVault" class="vault__auth">
          <p class="vault__sentline">
            Your vault needs an account, so it follows you between devices.
          </p>
          <NuxtLink to="/account" class="btn btn--primary">Sign in</NuxtLink>
        </div>

        <!-- the gear -->
        <div v-else>
          <div class="vault__bar">
            <div class="vault__searchwrap">
              <input
                ref="searchEl"
                v-model="query"
                class="field vault__search"
                type="search"
                placeholder="Search gear…"
                aria-label="Search gear"
              />
              <!-- our own clear, in the site's ink — WebKit's native one is a filled
                   blue circle-x (suppressed in atoms/controls.scss) -->
              <button
                v-if="query"
                type="button"
                class="vault__clear"
                aria-label="Clear search"
                title="Clear search"
                @click="clearQuery"
              >
                <CircleX :size="15" :stroke-width="2" />
              </button>
            </div>
          </div>

          <p v-if="loadError" class="t-sm vault__error">{{ loadError }}</p>

          <p v-if="loading" class="t-muted vault__empty">Loading your gear…</p>

          <template v-else-if="filtered.length">
            <p class="t-sm t-muted vault__count">
              {{ filtered.length }} {{ filtered.length === 1 ? "item" : "items" }} ·
              <!-- The total IS the unit control, the same object the editor's
                   TotalsBar puts up: figure, chevron, and a transparent native
                   select laid over the pair. A separate g/oz toggle sat off in the
                   search bar, away from the only number it governed. -->
              <span class="vault__total">
                {{ weightLabel(totalMg) }}
                <ChevronDown class="vault__chev" :size="14" :stroke-width="2.25" aria-hidden="true" />
                <select
                  class="vault__unitsel"
                  title="Change unit"
                  aria-label="Weight unit"
                  :value="system"
                  @change="setSystem(($event.target as HTMLSelectElement).value as 'metric' | 'imperial')"
                >
                  <option value="metric">g</option>
                  <option value="imperial">oz</option>
                </select>
              </span>
            </p>
            <!-- The editor's folder, class for class — the header grid, the
                 collapse chevron, the trailing sort · delete · grip cluster and the
                 1fr↔0fr body all come from atoms/folder.scss, so the two surfaces
                 can't drift. Searching flattens the grouping (see `grouped`): a
                 query asks about the whole vault, and answering it inside a dozen
                 mostly-empty headings buries the rows that matched. -->
            <section
              v-for="section in grouped"
              :key="section.folder ? section.folder.id : 'unfiled'"
              class="folder"
              :class="{
                'folder--dragging': section.folder && draggingFolder === section.folder.id,
                'folder--drop-before': section.folder && draggingFolder !== null && folderDrop === section.folder.id,
                'folder--drop-into':
                  draggingItem !== null &&
                  itemDrop !== undefined &&
                  itemDrop === (section.folder ? section.folder.id : null),
              }"
              :data-vault-folder="section.folder ? section.folder.id : ''"
              :data-collapsed="section.folder && collapsed[section.folder.id] ? true : null"
            >
              <header v-if="!query" class="folder__head">
                <div class="folder__title">
                  <input
                    v-if="section.folder"
                    class="field folder__name"
                    :value="section.folder.name"
                    aria-label="Folder name"
                    autocorrect="off"
                    spellcheck="false"
                    @change="renameFolder(section.folder, $event)"
                  />
                  <!-- unfiled isn't a folder you made: no name to edit, nothing to
                       delete or sort — just a heading over what's left over -->
                  <span v-else class="field folder__name vault__unfiled">Unfiled</span>
                  <button
                    v-if="section.folder"
                    class="folder__collapse"
                    :aria-expanded="!collapsed[section.folder.id]"
                    :aria-label="`${collapsed[section.folder.id] ? 'Expand' : 'Collapse'} ${section.folder.name}`"
                    @click="toggleCollapsed(section.folder.id)"
                  >
                    <ChevronDown
                      class="folder__chev"
                      :class="{ 'is-collapsed': collapsed[section.folder.id] }"
                      :size="20"
                      :stroke-width="2"
                    />
                  </button>
                </div>

                <div v-if="section.folder" class="folder__actions">
                  <button
                    class="btn btn--icon btn--ghost folder__del"
                    title="Remove folder"
                    :aria-label="`Remove ${section.folder.name}`"
                    @click="deleteFolder(section.folder)"
                  >
                    <Trash2 :size="16" />
                  </button>
                  <div class="folder__sortwrap" :class="{ 'is-active': (section.folder.sortBy ?? 'manual') !== 'manual' }">
                    <component
                      :is="SORT_META[section.folder.sortBy ?? 'manual'].icon"
                      class="folder__sorticon"
                      :size="16"
                      :stroke-width="2"
                      aria-hidden="true"
                    />
                    <select
                      class="folder__sortsel"
                      :value="section.folder.sortBy ?? 'manual'"
                      :title="`Sort gear — ${SORT_META[section.folder.sortBy ?? 'manual'].label}`"
                      :aria-label="`Sort gear in ${section.folder.name}`"
                      @change="folderOp({ t: 'sort', id: section.folder.id, sortBy: ($event.target as HTMLSelectElement).value })"
                    >
                      <option v-for="key in SORT_ORDER" :key="key" :value="key">{{ SORT_META[key].label }}</option>
                    </select>
                  </div>
                  <button
                    class="btn btn--icon btn--ghost folder__grip"
                    title="Drag to reorder folder"
                    :aria-label="`Reorder ${section.folder.name}`"
                    @pointerdown="startFolderDrag(section.folder.id, $event)"
                  >
                    <GripVertical :size="16" />
                  </button>
                </div>
              </header>

              <div class="folder__body">
                <div class="folder__bodyinner">
                  <p v-if="!section.entries.length" class="t-sm t-muted vault__folderempty">
                    Nothing filed here yet.
                  </p>
                  <ul v-else class="vault__list">
                    <li
                      v-for="entry in section.entries"
                      :key="entry.id"
                      class="vault__row"
                      :class="{ 'vault__row--dragging': draggingItem === entry.id }"
                      @pointerdown="onRowPointerDown(entry.id, $event)"
                    >
                      <div class="vault__main">
                        <p class="vault__name">
                          <span v-if="entry.brand" class="vault__brand">{{ entry.brand }}</span>
                          <span>{{ entry.name }}</span>
                          <span v-if="entry.variant" class="vault__variant"><span class="sep">·</span> {{ entry.variant }}</span>
                        </p>
                        <p v-if="entry.commonName" class="t-sm t-muted vault__meta">{{ entry.commonName }}</p>
                      </div>
                      <span class="t-num vault__weight">{{ weightLabel(entry.weightMg) }}</span>
                      <!-- Move-to-folder: a quiet glyph with a transparent native
                           select over it — the same recipe as the folder header's
                           sort control and the item rows' classification picker.
                           It used to render the folder's NAME on every row, which
                           under a "Cook kit" heading meant every row repeating
                           "Cook kit"; the heading already says where you are. The
                           select still names every destination when you open it,
                           and it's the keyboard and touch path for moving gear. -->
                      <div class="vault__movewrap">
                        <FolderIcon class="vault__moveicon" :size="15" :stroke-width="2" aria-hidden="true" />
                        <select
                          class="vault__movesel"
                          :value="entry.folderId ?? ''"
                          :title="`Move ${itemDisplayName(entry.brand, entry.name, entry.variant)} to a folder`"
                          :aria-label="`Folder for ${itemDisplayName(entry.brand, entry.name, entry.variant)}`"
                          @change="folderOp({ t: 'move', itemId: entry.id, folderId: ($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : null })"
                        >
                          <option value="">Unfiled</option>
                          <option v-for="f in folders" :key="f.id" :value="f.id">{{ f.name }}</option>
                        </select>
                      </div>
                      <!-- glyph only, like every other row action on the site: the
                           word was the widest thing in the row and said what the
                           bin already says. The label lives on aria-label + title. -->
                      <button
                        type="button"
                        class="btn btn--icon btn--ghost vault__remove"
                        :disabled="removing === entry.id"
                        :title="`Remove ${itemDisplayName(entry.brand, entry.name, entry.variant)}`"
                        :aria-label="`Remove ${itemDisplayName(entry.brand, entry.name, entry.variant)} from your gear vault`"
                        @click="remove(entry)"
                      >
                        <Trash2 :size="15" aria-hidden="true" />
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
            </section>

            <!-- new folders are made here rather than by a button that invents an
                 "Untitled folder" you then have to find and rename -->
            <form v-if="!query" class="vault__addfolder" @submit.prevent="addFolder">
              <input
                v-model="newFolder"
                class="field vault__addfolderinput"
                placeholder="New folder…"
                aria-label="New folder name"
                autocorrect="off"
              />
              <button v-if="newFolder.trim()" type="submit" class="btn">Add</button>
            </form>
          </template>

          <div v-else-if="query" class="vault__empty">
            <p class="t-muted">Nothing here matches “{{ query }}”.</p>
          </div>

          <div v-else class="vault__empty">
            <p class="t-muted">
              Your gear vault is empty. Add gear to a list and it’ll show up here on its own.
            </p>
            <NuxtLink to="/e" class="btn btn--primary">Create a list</NuxtLink>
          </div>

          <!-- The way back from Remove. Behind a disclosure, and only when there IS
               something removed: it's a repair affordance, not part of browsing your
               gear, and an always-visible "Removed (0)" would be clutter on the
               common case. Capture deliberately can't undo a removal for you, so
               this is the one place a removal is reversible after the undo toast
               has gone. -->
          <div v-if="removed.length" class="vault__removed">
            <button
              type="button"
              class="btn btn--quiet vault__disclose"
              :aria-expanded="showRemoved"
              @click="showRemoved = !showRemoved"
            >
              {{ showRemoved ? "Hide removed gear" : `Removed gear (${removed.length})` }}
            </button>
            <div v-if="showRemoved" class="vault__removedbody">
              <p class="t-sm t-muted">
                Removed gear stays out of your gear vault and out of the suggestions, even if it's
                still in a list. Put a piece back and it's yours again.
              </p>
              <ul class="vault__list">
                <li v-for="entry in removed" :key="entry.id" class="vault__row">
                  <div class="vault__main">
                    <p class="vault__name">
                      <span v-if="entry.brand" class="vault__brand">{{ entry.brand }}</span>
                      <span>{{ entry.name }}</span>
                      <span v-if="entry.variant" class="vault__variant"><span class="sep">·</span> {{ entry.variant }}</span>
                    </p>
                    <p v-if="entry.commonName" class="t-sm t-muted vault__meta">{{ entry.commonName }}</p>
                  </div>
                  <span class="t-num vault__weight">{{ weightLabel(entry.weightMg) }}</span>
                  <button
                    type="button"
                    class="btn btn--quiet vault__remove"
                    :disabled="restoring === entry.id"
                    :aria-label="`Put ${itemDisplayName(entry.brand, entry.name, entry.variant)} back in your gear vault`"
                    @click="putBack(entry)"
                  >
                    <Undo2 :size="14" aria-hidden="true" /> Put back
                  </button>
                </li>
              </ul>
            </div>
          </div>

        </div>

        <!-- The signed-out branch above doubles as the "still resolving" state:
             the session is fetched after hydration, so hasVault is briefly false
             for someone who IS signed in. That resolves to the gear in a moment
             and the sign-in copy is honest in the meantime. #fallback covers SSR. -->
        <template #fallback>
          <p class="t-muted vault__empty">Loading…</p>
        </template>
      </ClientOnly>
    </main>

    <!-- Removal lands as the site's undo toast, the same object the editor puts up
         when you remove an item — same surface, same "Removed <thing> · Undo"
         shape, same place on screen. It was an inline line in the content flow,
         which pushed the list down as it appeared and read as a status message
         rather than as an action you still have. The 10s window is unchanged; it
         just lives somewhere you don't have to be scrolled to the top to see. -->

    <Transition name="toast">
      <div v-if="undoable" class="toast undobar">
        <span class="t-sm">
          Removed <strong>{{ itemDisplayName(undoable.brand, undoable.name, undoable.variant) }}</strong>
        </span>
        <button class="undobar__btn t-sm" @click="undoRemove">
          <Undo2 :size="14" /> Undo
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
.page {
  padding-block: var(--space-5) var(--space-9);
}
.vault__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-6);
}
.vault__sub {
  max-width: 56ch;
}
/* Signed out there is one thing to do, so the column centres and narrows — the
   same shape /account uses for the same reason. Signed in the page is a wide,
   left-aligned list of gear, which is why this is scoped to the signed-out block
   rather than the page. */
.vault__auth {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  max-width: 34rem;
  margin-inline: auto;
  padding-block: 0 var(--space-6);
  text-align: center;
}
/* The heading block comes along, asked of the page's own structure rather than
   re-deriving the session state up there (see /account for the same trick).
   Its margin shrinks too: the column below sets its own top spacing, and the two
   were stacking into one 56px gap. ONE spacer owns it, and it's this one. */
.page:has(.vault__auth) .vault__head {
  text-align: center;
  max-width: 34rem;
  margin-inline: auto;
  margin-bottom: var(--space-4);
}
/* the shared .field is deliberately borderless (it sits inside list rows, where a
   box would be noise). On a standalone sign-in form there's nothing to show where
   to click, so give it the same bottom rule the editor's title field carries —
/* the passkey path, as a sentence rather than a second black button — it inherits
   the surrounding muted prose and only deepens on hover, like every other inline
/* same treatment for the gear search, which is the other standalone field here */
.vault__search {
  border-bottom: 1px solid var(--line);
}
.vault__search:focus {
  border-bottom-color: var(--ink-2);
}
.vault__sentline {
  color: var(--ink);
}
.vault__error {
  color: var(--ink);
}

/* --- the gear --- */
.vault__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.vault__searchwrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 32ch;
}
.vault__search {
  width: 100%;
  /* room for the clear button, so a long query doesn't run under it */
  padding-right: var(--space-5);
}
/* on the field, not beside it — see .vp__clear */
.vault__clear {
  position: absolute;
  right: 0;
  display: inline-flex;
  align-items: center;
  padding: 0;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vault__clear:hover,
.vault__clear:focus-visible {
  color: var(--ink);
}
/* The total, doubling as the unit control — the editor's .totals__amount recipe at
   this page's smaller type: a relative box holding the figure and its chevron, with
   an invisible native select stretched over both. The select is what's actually
   operated (so it keeps the platform's own picker and its keyboard behaviour); the
   figure and chevron are only what you see. */
.vault__total {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-px);
  color: var(--ink-2);
}
.vault__chev {
  flex: none;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vault__total:hover {
  color: var(--ink);
}
/* :has, not a sibling combinator — the select is laid over the pair and comes
   AFTER the chevron in the DOM, so `+` would never match it. The editor's version
   has no focus cue at all; keyboard users deserve the same hint the pointer gets. */
.vault__total:hover .vault__chev,
.vault__total:has(.vault__unitsel:focus-visible) .vault__chev {
  color: var(--ink);
}
.vault__unitsel {
  position: absolute;
  inset: 0;
  width: 100%;
  border: 0;
  opacity: 0; /* invisible — the figure + chevron are the visible affordance */
  cursor: pointer;
}
.vault__count {
  margin-bottom: var(--space-2);
}
/* de-outlined rows, separated by hairlines — matches "Your lists" */
.vault__list {
  list-style: none;
  display: flex;
  flex-direction: column;
}
.vault__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  /* same block padding as a row on "Your lists" — they're the same pattern (a
     de-outlined row on a hairline), so they must sit on the same rhythm */
  padding-block: var(--space-4);
}
.vault__row + .vault__row {
  border-top: 1px solid var(--line);
}
.vault__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-px);
}
/* ONE ellipsized run — the same treatment the vault pane gives this line, and for
   the same reasons. Shrinking the three parts as separate flex items made a long row
   spend three ellipses to say one thing ("Mountain Hardw… Ghost Whisperer UL Hoo… ·
   Men's…"), and squeezed the brand — the shortest, most identifying part — down to a
   sliver that still held its box and its gap, so that row's name started a few pixels
   in and sat out of line with the column.
   Plain inline text truncates once, at the end: every row begins in the same place,
   the brand always survives whole, and what yields is the variant and then the tail
   of the model, which is where the redundancy is. */
.vault__name {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
/* the gaps are margins, not the whitespace between the tags — Vue's compiler
   condenses a newline between elements away entirely */
.vault__brand {
  margin-right: 0.4ch;
  color: var(--ink-2);
}
.vault__variant {
  margin-left: 0.4ch;
  font-style: italic;
  color: var(--ink-3);
}
.vault__weight {
  flex: none;
  color: var(--ink-2);
  /* a fixed column so the weights line up down the list instead of ragging with
     the name lengths beside them */
  min-width: 5rem;
  text-align: right;
}
/* sizing + hover come from .btn--icon .btn--ghost; only the quiet resting ink is
   ours, matching the folder header's delete beside it */
.vault__remove {
  flex: none;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vault__remove:hover {
  color: var(--ink);
}
.vault__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}
/* the quiet footer disclosures — affordances, not calls to action. The
   link it reveals is a capability, so nothing about this should invite a casual
   click; it sits below the gear, under a hairline, like the "Your account" link it
   replaced. */

/* Everything about a folder's LOOK — the header grid, the name field, the collapse
   chevron, the trailing sort · delete · grip cluster, the 1fr↔0fr body — comes from
   atoms/folder.scss, the same rules the editor renders. Only what's specific to a
   VAULT folder lives here. */
.folder + .folder {
  margin-top: var(--space-6);
}
/* the lifted folder + its drop line, the same two states the editor shows (its own
   copies stay scoped there because they also cover the item-drag pass) */
.folder--dragging {
  opacity: 0.4;
}
/* the folder a dragged row will land in — a tint rather than an insertion line,
   because a vault folder has no slot to aim at (its order is its sortBy) */
.folder--drop-into {
  background: var(--paper-2);
  border-radius: var(--radius-2);
  box-shadow: 0 0 0 var(--space-2) var(--paper-2);
}
.vault__row--dragging {
  opacity: 0.4;
}
.folder--drop-before::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: calc(-1 * var(--space-3));
  height: var(--space-px);
  background: var(--ink);
  pointer-events: none;
}
/* "Unfiled" is a heading, not an editable name — it borrows the name's type so it
   sits on the same line as a real folder's, without being a field */
.vault__unfiled {
  color: var(--ink-2);
  cursor: default;
}
.vault__folderempty {
  padding-block: var(--space-2);
}
/* the folder header's .folder__sortwrap recipe, at row scale: a glyph that shows
   the control exists, with the real <select> laid transparently over it so the
   platform picker and full keyboard access come for free */
.vault__movewrap {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn);
  min-height: var(--icon-btn);
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vault__movewrap:hover {
  color: var(--ink);
}
.vault__moveicon {
  pointer-events: none;
}
.vault__movesel {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
}
/* making a folder is typing its name — no button that invents an "Untitled folder"
   for you to hunt down and rename */
.vault__addfolder {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-6);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line);
}
.vault__addfolderinput {
  flex: 0 1 22ch;
}

/* the removed-gear disclosure sits as a quiet footer to
   the page proper — same hairline seam, so they read as a pair of asides */
.vault__removed {
  margin-top: var(--space-7);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line);
}
.vault__removedbody {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}
/* the rows are the same object as the live ones, just dimmed — they're out of the
   vault, and the page shouldn't offer them with the same weight as gear you have */
.vault__removedbody .vault__row {
  opacity: 0.6;
}
.vault__removedbody .vault__row:hover {
  opacity: 1;
}
.vault__linkrow {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
/* the link is long and must not wrap — it reads as one object you copy whole */
.vault__linkfield {
  flex: 1;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}

@media (max-width: $bp-stack) {
  /* the search keeps the full width; the unit toggle drops beneath it */
  .vault__bar {
    flex-wrap: wrap;
  }
  .vault__search {
    max-width: none;
    flex-basis: 100%;
  }
  /* name on its own line, weight + remove beneath — nothing cramped */
  .vault__row {
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .vault__main {
    flex-basis: 100%;
  }
  .vault__weight {
    min-width: 0;
    text-align: left;
  }
    .vault__remove {
    margin-left: auto;
  }
}
</style>
