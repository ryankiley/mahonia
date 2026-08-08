<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ArrowUpDownIcon, ChevronDownIcon, CircleXIcon, Delete02Icon, FolderIcon, GripVerticalIcon, SortingAZ01Icon, SortingNineOneIcon, SortingOneNineIcon, UndoIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import type { VaultEntry, VaultFolder } from "~~/shared/vault";
import { formatWeightAuto, itemDisplayName } from "~~/shared/weights";
import { foldApostrophes } from "~~/shared/tidyText";

// "My Gear" — every piece of gear you've put in a list, in one place, so building
// the next list is picking rather than retyping. That's the name the chrome uses
// everywhere; "vault" survives as the internal word (routes, API, schema, classes).
//
// Owned by your ACCOUNT — the one part of Mahonia that asks you to sign in. Lists
// stay link-owned and always will; a vault is different because it's the durable
// record of what you own, and the thing you'd most hate to lose to a cleared
// browser. Signing in on another device is what carrying it there means now.
//
// noindex: it's one person's possessions and there is nothing here for a crawler.
useHead({
  title: "My Gear — Mahonia",
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
    loadError.value = "Couldn’t load your gear. Check your connection and try again.";
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
// Both sides fold their apostrophes (see foldApostrophes): the rows are stored tidied,
// so "Ryan’s repair kit" is on screen while the keyboard types "Ryan's", and a literal
// includes() would answer with nothing.
const filtered = computed(() => {
  const q = foldApostrophes(query.value.trim().toLowerCase());
  if (!q) return items.value;
  return items.value.filter((i) =>
    foldApostrophes(
      `${i.brand ?? ""} ${i.name} ${i.variant ?? ""} ${i.commonName ?? ""}`.toLowerCase(),
    ).includes(q),
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
// folders is [] until the async load assigns it, so the watch covers the first
// fill and every later change — there's nothing for an onMounted pass to read
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
const SORT_META: Record<VaultSort, { label: string; icon: typeof ArrowUpDownIcon }> = {
  manual: { label: "Manual order", icon: ArrowUpDownIcon },
  name: { label: "Name (A–Z)", icon: SortingAZ01Icon },
  heaviest: { label: "Heaviest first", icon: SortingNineOneIcon },
  lightest: { label: "Lightest first", icon: SortingOneNineIcon },
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
// there's nothing to tell the gesture apart from and no handle to add (and no
// touch hold either: with no click to protect, travel alone is the reading).
// The shared press-arm scaffold separates a drag from a stray press by a small
// travel threshold, and a press that starts on a control (the folder picker,
// the bin) is left alone.
const rowPress = createPressArm<number>({
  threshold: 5,
  exclude: "select, button", // a select or a button owns its own press
  onDrag: startItemDrag,
});
onBeforeUnmount(rowPress.end);

function startItemDrag(id: number, ev: PointerEvent) {
  draggingItem.value = id;
  itemDrag.start(String(id), ev);
}

// "Add folder" is a quiet label that becomes an inline field on press, and commits on
// enter or on clicking away — the same affordance (and the same words) the editor uses
// at the foot of its folder list. It used to be a permanently-open input with an "Add"
// button beside it, which read as an empty form the page was waiting on rather than an
// action you could take.
const addingFolder = ref(false);
const newFolderRef = useTemplateRef<HTMLInputElement>("newFolderRef");
function openAddFolder() {
  addingFolder.value = true;
  nextTick(() => newFolderRef.value?.focus());
}
function addFolder() {
  const name = newFolderRef.value?.value.trim();
  addingFolder.value = false;
  if (!name) return;
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
        ? `The ${held} ${held === 1 ? "piece" : "pieces"} of gear in it stay in My Gear — they just won’t be filed under anything.`
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


// Sign in without losing the vault behind it — the account opens over this page.
const { open: openAccount } = useAccountModal();
// the shape SortMenu takes — see FolderSection, which renders the same control
const SORT_OPTIONS = SORT_ORDER.map((key) => ({ key, label: SORT_META[key].label, icon: SORT_META[key].icon }));
// the vault stores a SYSTEM, not a unit — one choice with two faces
const UNIT_OPTIONS = [
  { key: "metric", label: "Grams (g)" },
  { key: "imperial", label: "Ounces (oz)" },
];
// every destination a row can move to. "" is Unfiled, which is a real destination
// here rather than an empty state — the vault keeps unfiled gear.
const folderOptions = computed(() => [
  { key: "", label: "Unfiled" },
  ...folders.value.map((f) => ({ key: String(f.id), label: f.name })),
]);
</script>

<template>
  <div>
    <SiteTopbar label="My Gear">
      <NuxtLink to="/e" class="btn btn--link">Create a list</NuxtLink>
    </SiteTopbar>

    <main id="main-content" tabindex="-1" class="wrap page vault__page">
      <!-- The sentence IS the heading. "My Gear" was being said twice — once
           here and once in the top bar's label — and of the two this is the one
           that tells you something. Still an h1, so the page keeps exactly one and
           the document outline is intact; the bar carries the page's name. -->
      <div class="vault__head">
        <h1 class="t-title vault__sub">All your gear, in one place.</h1>
      </div>

      <ClientOnly>

        <!-- Signed out. The subtitle above already says what a vault IS, so this
             only has to answer the question that subtitle raises — why this one
             thing wants an account — and get out of the way. Lists are named
             because that's the promise people came for, and this page must not
             read as it being withdrawn.
             WORD FOR WORD the vault pane's own prompt (VaultPane). It is the same
             question asked in two places, and answering it twice in two voices is
             how a product starts sounding like two products. Change one, change
             both. -->
        <div v-if="!hasVault" class="vault__auth">
          <p class="vault__sentline">
            Your gear is one pick away on every list, but it needs an account.
          </p>
          <button type="button" class="btn btn--primary" @click="openAccount">Sign in</button>
        </div>

        <!-- the gear -->
        <div v-else>
          <div class="vault__bar">
            <div class="vault__searchwrap">
              <input
                ref="searchEl"
                v-model="query"
                class="field well vault__search"
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
                <HugeiconsIcon :icon="CircleXIcon" :size="16" :stroke-width="2" />
              </button>
            </div>
          </div>

          <p v-if="loadError" class="t-sm vault__error">{{ loadError }}</p>

          <p v-if="loading" class="t-muted vault__empty">Loading your gear…</p>

          <template v-else-if="filtered.length">
            <p class="t-sm t-muted vault__count">
              {{ filtered.length }} {{ filtered.length === 1 ? "item" : "items" }} ·
              <!-- The total IS the unit control, the same object the editor's
                   TotalsBar puts up: figure and chevron, opening the app's own picker.
                   A separate g/oz toggle sat off in the search bar, away from the only
                   number it governed. -->
              <OptionMenu
                class="vault__total"
                :options="UNIT_OPTIONS"
                :current="system"
                label="Weight unit"
                title="Change unit"
                @pick="(k) => setSystem(k as 'metric' | 'imperial')"
              >
                <template #trigger="{ open }">
                  {{ weightLabel(totalMg) }}
                  <HugeiconsIcon :icon="ChevronDownIcon" class="vault__chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2.25" aria-hidden="true" />
                </template>
              </OptionMenu>
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
                    <HugeiconsIcon :icon="ChevronDownIcon" class="folder__chev"
                      :class="{ 'is-collapsed': collapsed[section.folder.id] }"
                      :size="20"
                      :stroke-width="2" />
                  </button>
                </div>

                <div v-if="section.folder" class="folder__actions">
                  <button
                    class="btn btn--icon btn--ghost folder__del"
                    title="Remove folder"
                    :aria-label="`Remove ${section.folder.name}`"
                    @click="deleteFolder(section.folder)"
                  >
                    <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="2" />
                  </button>
                  <!-- the shared sort picker, same control the editor's folder headers
                       render. `!` on section.folder in @pick: the enclosing div is
                       v-if="section.folder", but that narrowing doesn't survive into an
                       arrow function's scope. -->
                  <OptionMenu
                    class="folder__sortwrap"
                    :class="{ 'is-active': (section.folder.sortBy ?? 'manual') !== 'manual' }"
                    trigger-class="btn btn--icon btn--ghost"
                    :options="SORT_OPTIONS"
                    :current="section.folder.sortBy ?? 'manual'"
                    :label="`Sort gear in ${section.folder.name}`"
                    @pick="(k) => folderOp({ t: 'sort', id: section.folder!.id, sortBy: k })"
                  >
                    <!-- SORT_META, not the slot's `active?.icon`: `active` is a find
                         over the options so its icon is a maybe, and the icon prop
                         doesn't take one. `!` for the same reason @pick's — a slot is
                         an arrow function's scope too. -->
                    <template #trigger>
                      <HugeiconsIcon :icon="SORT_META[section.folder!.sortBy ?? 'manual'].icon" class="folder__sorticon" :size="16" :stroke-width="2" aria-hidden="true" />
                    </template>
                  </OptionMenu>
                  <button
                    class="btn btn--icon btn--ghost folder__grip"
                    title="Drag to reorder folder"
                    :aria-label="`Reorder ${section.folder.name}`"
                    @pointerdown="startFolderDrag(section.folder.id, $event)"
                  >
                    <HugeiconsIcon :icon="GripVerticalIcon" :size="16" :stroke-width="2" />
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
                      @pointerdown="rowPress.start(entry.id, $event)"
                    >
                      <div class="gear__main">
                        <p class="gear__name">
                          <span v-if="entry.brand" class="gear__brand">{{ entry.brand }}</span>
                          <span>{{ entry.name }}</span>
                          <span v-if="entry.variant" class="gear__variant"><span class="sep">·</span> {{ entry.variant }}</span>
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
                      <OptionMenu
                        class="vault__movewrap"
                        trigger-class="btn btn--icon btn--ghost"
                        :options="folderOptions"
                        :current="String(entry.folderId ?? '')"
                        :label="`Folder for ${itemDisplayName(entry.brand, entry.name, entry.variant)}`"
                        :title="`Move ${itemDisplayName(entry.brand, entry.name, entry.variant)} to a folder`"
                        @pick="(k) => folderOp({ t: 'move', itemId: entry.id, folderId: k ? Number(k) : null })"
                      >
                        <template #trigger>
                          <HugeiconsIcon :icon="FolderIcon" class="vault__moveicon" :size="16" :stroke-width="2" aria-hidden="true" />
                        </template>
                      </OptionMenu>
                      <!-- glyph only, like every other row action on the site: the
                           word was the widest thing in the row and said what the
                           bin already says. The label lives on aria-label + title. -->
                      <button
                        type="button"
                        class="btn btn--icon btn--ghost vault__remove"
                        :disabled="removing === entry.id"
                        :title="`Remove ${itemDisplayName(entry.brand, entry.name, entry.variant)}`"
                        :aria-label="`Remove ${itemDisplayName(entry.brand, entry.name, entry.variant)} from My Gear`"
                        @click="remove(entry)"
                      >
                        <HugeiconsIcon :icon="Delete02Icon" :size="16" aria-hidden="true" :stroke-width="2" />
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
            </section>

            <!-- new folders are made here rather than by a button that invents an
                 "Untitled folder" you then have to find and rename -->
            <div v-if="!query" class="vault__addfolder">
              <input
                v-if="addingFolder"
                ref="newFolderRef"
                class="vault__addfolderinput"
                placeholder="Folder name"
                aria-label="New folder name"
                autocorrect="off"
                spellcheck="false"
                @keydown.enter.prevent="addFolder"
                @keydown.esc="addingFolder = false"
                @blur="addFolder"
              />
              <button v-else type="button" class="vault__addfolderbtn" @click="openAddFolder">Add folder</button>
            </div>
          </template>

          <div v-else-if="query" class="vault__empty">
            <p class="t-muted">Nothing here matches “{{ query }}”.</p>
          </div>

          <div v-else class="vault__empty">
            <p class="t-muted">
              No gear saved yet. Add gear to a list and it’ll show up here on its own.
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
                Removed gear stays out of My Gear and out of the suggestions, even if it's
                still in a list. Put a piece back and it's yours again.
              </p>
              <ul class="vault__list">
                <li v-for="entry in removed" :key="entry.id" class="vault__row">
                  <div class="gear__main">
                    <p class="gear__name">
                      <span v-if="entry.brand" class="gear__brand">{{ entry.brand }}</span>
                      <span>{{ entry.name }}</span>
                      <span v-if="entry.variant" class="gear__variant"><span class="sep">·</span> {{ entry.variant }}</span>
                    </p>
                    <p v-if="entry.commonName" class="t-sm t-muted vault__meta">{{ entry.commonName }}</p>
                  </div>
                  <span class="t-num vault__weight">{{ weightLabel(entry.weightMg) }}</span>
                  <button
                    type="button"
                    class="btn btn--quiet vault__remove"
                    :disabled="restoring === entry.id"
                    :aria-label="`Put ${itemDisplayName(entry.brand, entry.name, entry.variant)} back in My Gear`"
                    @click="putBack(entry)"
                  >
                    <HugeiconsIcon :icon="UndoIcon" :size="14" aria-hidden="true" :stroke-width="2" /> Put back
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
          <HugeiconsIcon :icon="UndoIcon" :size="14" :stroke-width="2" /> Undo
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
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
/* the tint itself is the shared .well atom (controls.scss) — CONTAINED, like the
   pane's search and the import dialog's box. The auth field above keeps the
   underline treatment: it is a single question on an otherwise empty page, not a
   tool in a working surface. */
/* balance, as the vault pane's copy of this sentence takes: it's centred, so a
   ragged right edge reads as a mistake rather than as rag, and at a narrow window
   the last word would otherwise strand on its own line. */
.vault__sentline {
  color: var(--ink);
  text-wrap: balance;
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
  padding-inline: var(--space-3);
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
.vault__total:focus-within .vault__chev {
  color: var(--ink);
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
/* the name cell (.gear__main / .gear__name / .gear__brand / .gear__variant) comes
   from atoms/gear.scss — shared with the vault pane, which used to hand-mirror
   these rules. Only the page's own mobile stack below touches it. */
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
/* the folder header's sort control at row scale: a glyph that shows the control
   exists, opening the app's own picker (OptionMenu) */
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
/* making a folder is typing its name — no button that invents an "Untitled folder"
   for you to hunt down and rename */
.vault__addfolder {
  display: inline-flex;
  align-items: center;
  margin-top: var(--space-6);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line);
  /* the seam belongs to the page, not to the label sitting on it — inline-flex would
     otherwise draw the rule only as wide as the words */
  align-self: stretch;
}
/* label + inline field share the folder-name type, label dimmer — the same pair of
   rules the editor's .editor__addfolderbtn / .editor__addfolderinput carry, so the
   two "Add folder"s are the same affordance in both places */
.vault__addfolderbtn,
.vault__addfolderinput {
  padding: 0;
  background: none;
  border: 0;
  font-family: var(--font);
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
}
.vault__addfolderbtn {
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.vault__addfolderbtn:hover {
  color: var(--ink);
}
.vault__addfolderinput {
  color: var(--ink);
  min-width: 12rem;
}
.vault__addfolderinput:focus {
  outline: none;
}
.vault__addfolderinput::placeholder {
  color: var(--ink-3);
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
/* touch: the hand-rolled icon controls meet the --tap minimum like every
   .btn--icon does (controls.scss). The clear overlays the field's end, so the
   bigger box only extends its hit area, not the layout; the move control mirrors
   the folder header's sortwrap recipe, glyph bump included (atoms/folder.scss). */
@media (pointer: coarse) {
  .vault__clear {
    justify-content: center;
    min-width: var(--tap);
    min-height: var(--tap);
  }
  .vault__movewrap {
    width: var(--tap);
    min-height: var(--tap);
  }
  .vault__moveicon {
    width: var(--icon-touch);
    height: var(--icon-touch);
  }
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
  .gear__main {
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
