<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChartAverageIcon, ChevronDownIcon, Clock01Icon, Delete02Icon, FolderIcon, GripVerticalIcon, SortingAZ01Icon, SortingNineOneIcon, SortingOneNineIcon, UndoIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import { UNITS } from "~~/shared/types";
import type { VaultEntry, VaultFolder } from "~~/shared/vault";
import { formatWeight, itemDisplayName, parseWeightInput } from "~~/shared/weights";
import {
  filterVaultRows,
  groupVaultRows,
  searchVaultRows,
  sortVaultRows,
  type VaultSection,
  type VaultShow,
  type VaultView,
} from "~~/shared/vaultView";
import { WEIGHT_UNIT_OPTIONS } from "~/utils/unitOptions";

// "My Gear" — every piece of gear you've put in a list, in one place, so building
// the next list is picking rather than retyping. That's the name the chrome uses
// everywhere, and /gear the URL people see; "vault" survives as the internal word
// (the API is /api/vault/*, the tables vault_*, the classes .vault__*) — see the
// /vault redirect in nuxt.config for that decision.
//
// Owned by your ACCOUNT — the one part of Mahonia that asks you to sign in. Lists
// stay link-owned and always will; a vault is different because it's the durable
// record of what you own, and the thing you'd most hate to lose to a cleared
// browser. Signing in on another device is what carrying it there means now.
//
// It is also the one place the gear itself can be MAINTAINED: added by hand, and
// corrected in place. Everything else writes here automatically from a list, and an
// automatic write must never talk over a deliberate one — so an edit PINS the field
// it touched (see captureVaultItems).
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
// load once we know whether there’s a vault to load, and again when that flips —
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

// ---- how you're looking at it --------------------------------------------
// Two questions, two controls: WHICH gear (Show) and IN WHAT ORDER (View). Neither
// is persisted, unlike a folder's collapse state — a collapsed folder still shows
// its heading, whereas a remembered "Worn only" would greet you next visit with a
// gear that looks like it has lost most of your gear.
//
// The pipeline itself is shared/vaultView.ts: pure, and unit-tested without a
// browser, which is where the rules that are invisible until they're wrong live (the
// ranker's limit, "base means absent too", when a heading disappears).
const view = ref<VaultView>("folders");
const show = ref<VaultShow>("all");

const shown = computed(() => filterVaultRows(items.value, show.value));
const found = computed(() => searchVaultRows(shown.value, query.value));
// A query and a View both claim the order, so one has to yield. RELEVANCE wins under
// the default view — you typed a question and the best answers belong at the top,
// which is what the ranker's cascade is for. An explicitly chosen View wins over
// relevance: you asked for heaviest first, and quietly re-ordering by match quality
// would be the page ignoring the control you just used.
const filtered = computed(() =>
  view.value === "folders" ? found.value : sortVaultRows(found.value, view.value),
);
// A chosen order flattens, and so does a search — see groupVaultRows for why.
const flat = computed(() => view.value !== "folders" || !!query.value.trim());
const grouped = computed<VaultSection[]>(() =>
  flat.value
    ? []
    : groupVaultRows(filtered.value, folders.value, { keepEmpty: show.value === "all" }),
);
const narrowed = computed(() => filtered.value.length !== items.value.length);

const totalMg = computed(() => filtered.value.reduce((sum, i) => sum + i.weightMg, 0));

// The line under an empty result, derived from whichever control emptied it — "no
// worn gear" and "nothing matches 'duplx'" are different facts, and one generic
// sentence would leave you guessing which control to undo.
const noneLine = computed(() => {
  if (query.value.trim()) return `Nothing here matches “${query.value.trim()}”.`;
  if (show.value === "unfiled") return "Everything is filed.";
  if (show.value !== "all") return `No ${show.value} gear in My Gear yet.`;
  return "";
});

// ---- folders -------------------------------------------------------------
// Collapse, the same mechanism the editor's folders use: persisted per folder id so
// a collapsed folder stays collapsed across reloads, and never sent to the server —
// it's how YOU are looking at the vault, not a fact about the gear. Keyed under
// gear.vfold.* rather than the editor's gear.fold.* because a vault folder id (an
// integer) and a list folder id (a uuid) share a namespace otherwise.
const vfoldCollapse = usePersistedCollapse("gear.vfold.");
const collapsed = ref<Record<number, boolean>>({});
// folders is [] until the async load assigns it, so the watch covers the first
// fill and every later change — there's nothing for an onMounted pass to read
watch(folders, (list) => list.forEach((f) => (collapsed.value[f.id] = vfoldCollapse.isCollapsed(f.id))));
function toggleCollapsed(id: number) {
  collapsed.value[id] = vfoldCollapse.toggle(id);
}

// A row's folder picker is absolutely positioned and .folder__bodyinner clips
// (overflow: hidden, for the collapse animation), so a menu opened on the last row
// of a folder was guillotined — useMenuPlacement flips against the VIEWPORT, which
// knows nothing about the clip. Count the open overlays per folder and lift the clip
// while any is, exactly as FolderSection does for its own rows.
const overlays = ref<Record<string, number>>({});
function onOverlayToggle(key: string, open: boolean) {
  overlays.value[key] = Math.max(0, (overlays.value[key] ?? 0) + (open ? 1 : -1));
}
const sectionKey = (s: VaultSection) => (s.folder ? String(s.folder.id) : "unfiled");

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
    const over = el?.closest("[data-gear-folder]") as HTMLElement | null;
    const id = Number(over?.getAttribute("data-gear-folder"));
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
// The drop target is the FOLDER, not a slot within it: a vault folder's rows come
// in the server's order (most recently used first), so there is no position to aim
// at — unlike the list, where dropping between two rows is the whole point.
const draggingItem = ref<number | null>(null);
// number = a folder, null = unfiled, undefined = not over a drop target
const itemDrop = ref<number | null | undefined>(undefined);
const itemDrag = createPointerDrag<number | null>({
  track(ev, el) {
    const over = el?.closest("[data-gear-folder]") as HTMLElement | null;
    // off every section (the page margins, the header) — hold the last target so a
    // wobble mid-drag doesn't drop the indicator
    if (!over) return;
    const attr = over.getAttribute("data-gear-folder");
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
// travel threshold, and a press that starts on a control (the folder picker, the
// pencil, the bin) is left alone.
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
  // counted over ALL the gear, not the filtered view: the number in the question has
  // to be the number that actually moves, and a "Show: Worn" filter would otherwise
  // promise that two pieces are affected while eleven are
  const held = items.value.filter((i) => i.folderId === f.id).length;
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

// ---- adding gear by hand -------------------------------------------------
// The half capture can't do. Gear arrives here on its own from every list you build,
// which covers the common case beautifully and answers nothing at all for the pack
// you bought yesterday and haven't packed yet.
//
// Per-folder rather than one control at the top, so the affordance IS the
// destination — a page-level add would need a "file it in…" picker beside it, which
// is a whole extra control on a page that should stay quiet. Press-to-open, like
// "Add folder" right below it: a quiet label, not an empty form the page is waiting on.
const addingIn = ref<string | null>(null);
const addName = ref("");
const addWeight = ref("");
const addBusy = ref(false);
const addRow = useTemplateRef<{ focus: () => void }>("addRow");

function openAdd(folderId: number | null) {
  addingIn.value = folderId === null ? "unfiled" : String(folderId);
  addName.value = "";
  addWeight.value = "";
}
function closeAdd() {
  addingIn.value = null;
  addName.value = "";
  addWeight.value = "";
}
async function commitAdd(folderId: number | null) {
  const name = addName.value.trim();
  if (!name || addBusy.value) return;
  const raw = addWeight.value.trim();
  const weightMg = raw ? parseWeightInput(raw, unit.value) : 0;
  if (weightMg == null) {
    loadError.value = "That weight doesn’t read as a number. Try “540 g” or “1.2 kg”.";
    return;
  }
  addBusy.value = true;
  loadError.value = "";
  try {
    const res = await vaultFetch<{ ok: boolean; reason?: string }>("/api/vault/items", {
      method: "POST",
      body: { op: { t: "add", name, weightMg, folderId } },
    });
    if (!res.ok) {
      // The refusals are worth naming: "you already have that" tells you to search
      // for it, and a generic failure tells you to try again. Both are facts about
      // your own gear, so reporting them gives nothing away.
      loadError.value =
        res.reason === "duplicate"
          ? "You already have that in My Gear."
          : res.reason === "full"
            ? "My Gear is full. Remove something to make room."
            : "Couldn’t add that. Check your connection and try again.";
      addBusy.value = false;
      return;
    }
    await loadVault();
    // Committing re-opens a fresh pair — the editor's `advance` behaviour, which is
    // what makes typing in five things bearable rather than five separate presses.
    addName.value = "";
    addWeight.value = "";
    // the whole gear re-rendered under it, so the field is a new element
    nextTick(() => addRow.value?.focus());
  } catch {
    loadError.value = "Couldn’t add that. Check your connection and try again.";
  }
  addBusy.value = false;
}

// ---- editing in place ----------------------------------------------------
// The dialog is Lazy + v-if on "has it ever opened", so its chunk never loads for
// someone who only came to look — the LazyCatalogCorrectionModal idiom.
const editing = ref<VaultEntry | null>(null);
const editorEverOpened = ref(false);
function openEdit(entry: VaultEntry) {
  editorEverOpened.value = true;
  editing.value = entry;
}
// Patch the one row in place rather than re-reading the vault: the endpoint returns
// the row as it now stands, and a full reload would re-sort the page under a dialog
// that just closed (a rename can move a row under A–Z).
function onItemSaved(item: VaultEntry) {
  const at = items.value.findIndex((i) => i.id === item.id);
  if (at >= 0) items.value[at] = item;
  editing.value = null;
}

// ---- units ---------------------------------------------------------------
// The vault has no list to inherit a unit from, so it takes its default from the
// most recent list on this device (whatever you already work in) and remembers an
// explicit choice from there.
const UNIT_KEY = "gear.gear.unit.v1";
// The key before it stored a SYSTEM ("metric" | "imperial") rather than a unit,
// because the page formatted with formatWeightAuto and a system was all that took.
// It reads a column now — formatWeight, strict, like every other inventory column in
// the app — because auto-promotion put a 12 g stake and a 1.2 kg tent in different
// units in the same column, which cannot be read by eye and makes "Heaviest first"
// look broken. Mapped once on read so an ounces user still opens in ounces.
const LEGACY_SYSTEM_KEY = "gear.gear.system.v1";
const unit = ref<Unit>("g");
onMounted(() => {
  const saved = localStorage.getItem(UNIT_KEY);
  if (saved && (UNITS as string[]).includes(saved)) {
    unit.value = saved as Unit;
    return;
  }
  const legacy = localStorage.getItem(LEGACY_SYSTEM_KEY);
  if (legacy === "imperial" || legacy === "metric") {
    setUnit(legacy === "imperial" ? "oz" : "g");
    return;
  }
  // No stored choice: inherit the most recent list on this device — and inherit its
  // UNIT, not just its system. The old code flattened kg to "metric" and handed the
  // magnitude promoter a coin toss; a list kept in kg now opens the vault in kg.
  const recent = [...useMyLists().entries.value].sort((a, b) => b.lastOpened - a.lastOpened)[0];
  unit.value = recent?.displayUnit ?? "g";
});
function setUnit(next: Unit) {
  unit.value = next;
  remember(UNIT_KEY, next);
}
const weightLabel = (mg: number) => formatWeight(mg, unit.value);

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
  await putBack(entry); // restoring is restoring — same call the Removed section makes
}
onBeforeUnmount(() => clearTimeout(undoTimer));

// Sign in without losing the vault behind it — the account opens over this page.
const { open: openAccount } = useAccountModal();
// The page's own order. A–Z / Heaviest / Lightest wear the sort-key glyph family;
// Folders takes the folder mark because it is a LAYOUT, not a sort key, and
// shouldn't borrow one.
const VIEW_OPTIONS = [
  { key: "folders", label: "Folders", icon: FolderIcon },
  { key: "az", label: "A–Z", icon: SortingAZ01Icon },
  { key: "heaviest", label: "Heaviest", icon: SortingNineOneIcon },
  { key: "lightest", label: "Lightest", icon: SortingOneNineIcon },
  { key: "recent", label: "Recently used", icon: Clock01Icon },
  { key: "most", label: "Most used", icon: ChartAverageIcon },
];
const SHOW_OPTIONS = [
  { key: "all", label: "All gear" },
  { key: "unfiled", label: "Unfiled" },
  { key: "base", label: "Base" },
  { key: "worn", label: "Worn" },
  { key: "consumable", label: "Consumable" },
];
const viewLabel = computed(() => VIEW_OPTIONS.find((o) => o.key === view.value)?.label ?? "");
const showLabel = computed(() => SHOW_OPTIONS.find((o) => o.key === show.value)?.label ?? "");
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
      <!-- The page's name is in the top bar, and a tagline under it was saying a
           second time what the gear underneath says by being there. The heading
           survives for the document outline — exactly one h1, matching the bar. -->
      <h1 class="visually-hidden">My Gear</h1>

      <ClientOnly>

        <!-- Signed out. One question, so the column centres and narrows, and the
             sentence answers only the thing this page raises — why this one thing
             wants an account — before getting out of the way. Lists are named
             because that's the promise people came for, and this page must not
             read as it being withdrawn.
             WORD FOR WORD the gear pane's own prompt (VaultPane). It is the same
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
          <!-- Nothing to search, order or narrow until there IS gear — three
               controls over "Nothing here yet" is furniture for a room with no
               floor. Keyed on the folders too, so a gear you've emptied still
               offers them rather than flickering the bar away as the last row goes. -->
          <div v-if="items.length || folders.length" class="vault__bar">
            <!-- the field and its own clear — SearchField, the same control the gear
                 pane draws; only the sizing is this page's -->
            <SearchField
              v-model="query"
              class="vault__searchwrap"
              placeholder="Search gear…"
              label="Search gear"
            />

            <!-- The two questions a gear of two hundred rows raises, as the app's
                 own picker rather than two new controls: what order, and which gear.
                 They ride the trailing edge, over the rows' own trailing controls. -->
            <div class="vault__views">
              <OptionMenu
                class="vault__view"
                :options="VIEW_OPTIONS"
                :current="view"
                label="How to order My Gear"
                @pick="(k) => (view = k as VaultView)"
              >
                <template #trigger="{ open }">
                  <span class="t-muted">View</span>
                  <span>{{ viewLabel }}</span>
                  <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2.25" aria-hidden="true" />
                </template>
              </OptionMenu>
              <OptionMenu
                class="vault__view"
                :options="SHOW_OPTIONS"
                :current="show"
                label="Which gear to show"
                @pick="(k) => (show = k as VaultShow)"
              >
                <template #trigger="{ open }">
                  <span class="t-muted">Show</span>
                  <span>{{ showLabel }}</span>
                  <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2.25" aria-hidden="true" />
                </template>
              </OptionMenu>
            </div>
          </div>

          <p v-if="loadError" class="t-sm vault__error">{{ loadError }}</p>

          <!-- only while there is nothing to show yet. Every folder op and every add
               reloads the gear, and blanking a page you are working on for the
               length of a round trip reads as the page losing your gear. -->
          <p v-if="loading && !items.length" class="t-muted vault__empty">Loading your gear…</p>

          <!-- folders.length, not just the rows: a gear whose gear is all removed
               (or all filtered out) still has the headings you made, and the add row
               that puts gear back into them lives inside one. -->
          <template v-else-if="items.length || folders.length">
            <p class="t-sm t-muted vault__count">
              <template v-if="narrowed">{{ filtered.length }} of {{ items.length }}</template>
              <template v-else>{{ items.length }}</template>
              {{ items.length === 1 ? "item" : "items" }} ·
              <!-- The total IS the unit control, the same object the editor's
                   TotalsBar puts up: figure and chevron, opening the app's own picker.
                   A separate g/oz toggle sat off in the search bar, away from the only
                   number it governed. -->
              <OptionMenu
                class="vault__total"
                :options="WEIGHT_UNIT_OPTIONS"
                :current="unit"
                label="Weight unit"
                title="Change unit"
                @pick="(k) => setUnit(k as Unit)"
              >
                <template #trigger="{ open }">
                  {{ weightLabel(totalMg) }}
                  <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2.25" aria-hidden="true" />
                </template>
              </OptionMenu>
            </p>

            <!-- FLAT: a chosen order, or a search. One list, one order, no headings —
                 a folder already owns an order of its own, and two authorities over
                 the same rows is what makes "heaviest" mean nothing. -->
            <!-- the row is VaultGearRow, the same one a folder's list and the removed
                 list draw; the flat list has no drag, so it hands the row nothing else -->
            <ul v-if="flat" class="vault__list">
              <VaultGearRow
                v-for="entry in filtered"
                :key="entry.id"
                :entry="entry"
                :unit="unit"
                :folder-options="folderOptions"
                :busy="removing === entry.id"
                @edit="openEdit(entry)"
                @move="(folderId: number | null) => folderOp({ t: 'move', itemId: entry.id, folderId })"
                @remove="remove(entry)"
              />
            </ul>

            <!-- FOLDERS. The editor's folder, class for class — the header grid, the
                 collapse chevron, the trailing delete · grip cluster and the
                 1fr↔0fr body all come from atoms/folder.scss, so the two surfaces
                 can't drift. -->
            <template v-else>
              <section
                v-for="section in grouped"
                :key="sectionKey(section)"
                class="folder"
                :class="{
                  'folder--dragging': section.folder && draggingFolder === section.folder.id,
                  'folder--drop-before': section.folder && draggingFolder !== null && folderDrop === section.folder.id,
                  'folder--drop-into':
                    draggingItem !== null &&
                    itemDrop !== undefined &&
                    itemDrop === (section.folder ? section.folder.id : null),
                }"
                :data-gear-folder="section.folder ? section.folder.id : ''"
                :data-collapsed="section.folder && collapsed[section.folder.id] ? true : null"
              >
                <header class="folder__head">
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
                         delete — just a heading over what's left over -->
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

                  <!-- what the folder HOLDS. The editor's folder header has no
                       subtotal because the totals bar owns numbers there; here the
                       folder IS the unit you're comparing, and a shelf you can't
                       weigh is half a shelf. -->
                  <span v-if="section.count" class="t-sm t-num vault__foldersum">
                    {{ section.count }}<span class="visually-hidden"> {{ section.count === 1 ? "item" : "items" }}</span>
                    · {{ weightLabel(section.weightMg) }}
                  </span>

                  <div v-if="section.folder" class="folder__actions">
                    <button
                      class="btn btn--icon btn--ghost folder__del"
                      title="Remove folder"
                      :aria-label="`Remove ${section.folder.name}`"
                      @click="deleteFolder(section.folder)"
                    >
                      <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="2" />
                    </button>
                    <button
                      class="btn btn--icon btn--ghost grip folder__grip"
                      title="Drag to reorder folder"
                      :aria-label="`Reorder ${section.folder.name}`"
                      @pointerdown="startFolderDrag(section.folder.id, $event)"
                    >
                      <HugeiconsIcon :icon="GripVerticalIcon" :size="16" :stroke-width="2" />
                    </button>
                  </div>
                </header>

                <div class="folder__body">
                  <div
                    class="folder__bodyinner"
                    :class="{ 'is-overlay-open': (overlays[sectionKey(section)] ?? 0) > 0 }"
                  >
                    <!-- VaultGearRow, with what only a folder's row has: the press
                         that becomes a drag (a native listener on the row's root)
                         and its lifted state, plus the overlay count that lifts the
                         body's clip while a row's move menu is open. -->
                    <ul v-if="section.entries.length" class="vault__list">
                      <VaultGearRow
                        v-for="entry in section.entries"
                        :key="entry.id"
                        :entry="entry"
                        :unit="unit"
                        :folder-options="folderOptions"
                        :busy="removing === entry.id"
                        :class="{ 'vault__row--dragging': draggingItem === entry.id }"
                        @pointerdown="rowPress.start(entry.id, $event)"
                        @edit="openEdit(entry)"
                        @move="(folderId: number | null) => folderOp({ t: 'move', itemId: entry.id, folderId })"
                        @remove="remove(entry)"
                        @overlay-toggle="(o: boolean) => onOverlayToggle(sectionKey(section), o)"
                      />
                    </ul>

                    <!-- the add row IS the destination: press it and what you type
                         lands in this folder. Same wrapper rhythm as the editor's
                         (FolderRows) — the rule line above it, dropped when it's the
                         folder's first row. -->
                    <div class="vault__add" :class="{ 'vault__add--first': !section.entries.length }">
                      <VaultAddRow
                        v-if="addingIn === sectionKey(section)"
                        ref="addRow"
                        v-model:name="addName"
                        v-model:weight="addWeight"
                        :unit="unit"
                        :busy="addBusy"
                        @submit="commitAdd(section.folder ? section.folder.id : null)"
                        @done="closeAdd"
                      />
                      <button
                        v-else
                        type="button"
                        class="folder__addbtn"
                        @click="openAdd(section.folder ? section.folder.id : null)"
                      >
                        Add gear
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <!-- new folders are made here rather than by a button that invents an
                   "Untitled folder" you then have to find and rename -->
              <div class="addfolder vault__addfolder">
                <input
                  v-if="addingFolder"
                  ref="newFolderRef"
                  class="addfolder__input"
                  placeholder="Folder name"
                  aria-label="New folder name"
                  autocorrect="off"
                  spellcheck="false"
                  @keydown.enter.prevent="addFolder"
                  @keydown.esc="addingFolder = false"
                  @blur="addFolder"
                />
                <button v-else type="button" class="addfolder__btn" @click="openAddFolder">Add folder</button>
              </div>
            </template>

            <!-- a filter or a search that matched nothing. The line names the control
                 that emptied the page, so you know which one to undo. -->
            <p v-if="!filtered.length && noneLine" class="t-muted vault__none">{{ noneLine }}</p>

            <!-- a flat view has no folder to hang an add row off, so it gets one at
                 the foot. Unfiled, because there is no destination on screen to mean. -->
            <div v-if="flat && !query" class="vault__add vault__add--flat">
              <VaultAddRow
                v-if="addingIn === 'unfiled'"
                ref="addRow"
                v-model:name="addName"
                v-model:weight="addWeight"
                :unit="unit"
                :busy="addBusy"
                @submit="commitAdd(null)"
                @done="closeAdd"
              />
              <button v-else type="button" class="folder__addbtn" @click="openAdd(null)">Add gear</button>
            </div>
          </template>

          <!-- Nothing at all: no gear, no folders. Adding is offered FIRST — the
               capture sentence is still true and still the faster path, but it
               answers "how does gear get here eventually", not "how do I put the
               pack I bought yesterday in". -->
          <div v-else class="vault__empty">
            <p class="t-muted">
              Nothing here yet. Add a piece of gear, or build a list and it’ll collect
              itself here.
            </p>
            <VaultAddRow
              v-if="addingIn === 'unfiled'"
              ref="addRow"
              v-model:name="addName"
              v-model:weight="addWeight"
              :unit="unit"
              :busy="addBusy"
              @submit="commitAdd(null)"
              @done="closeAdd"
            />
            <div v-else class="vault__emptyacts">
              <button type="button" class="btn btn--primary" @click="openAdd(null)">Add gear</button>
              <NuxtLink to="/e" class="btn btn--ghost">Create a list</NuxtLink>
            </div>
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
              <!-- the same row, in its removed shape: name and weight, and the way back -->
              <ul class="vault__list">
                <VaultGearRow
                  v-for="entry in removed"
                  :key="entry.id"
                  :entry="entry"
                  :unit="unit"
                  :busy="restoring === entry.id"
                  removed
                  @restore="putBack(entry)"
                />
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

    <!-- Lazy + "has it ever opened", so the dialog's chunk never loads for someone
         who came to look rather than to correct — the same idiom the editor uses for
         its own modals. -->
    <LazyVaultItemModal
      v-if="editorEverOpened"
      :entry="editing"
      :unit="unit"
      @close="editing = null"
      @saved="onItemSaved"
    />

    <!-- Removal lands as the site's undo toast, the same object the editor puts up
         when you remove an item — same surface, same "Removed <thing> · Undo"
         shape, same place on screen. -->
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
  padding-block: var(--space-5) var(--space-6);
  text-align: center;
}
/* balance, as the gear pane's copy of this sentence takes: it's centred, so a
   ragged right edge reads as a mistake rather than as rag, and at a narrow window
   the last word would otherwise strand on its own line. */
.vault__sentline {
  color: var(--ink);
  text-wrap: balance;
}
.vault__error {
  color: var(--ink);
}

/* --- the bar --- */
.vault__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  /* wraps at EVERY width, not only below $bp-stack: three controls on one line is
     already close, and a narrowed desktop window should drop the pickers to their
     own line rather than crush the field they sit beside */
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}
/* the search is SearchField (the field, its clear, the touch target); this page only
   sizes it — it takes the slack up to a cap, so it never becomes a bar */
.vault__searchwrap {
  flex: 1 1 20ch;
  min-width: 0;
  max-width: 32ch;
}
/* the two pickers ride the trailing edge, over the rows' own trailing controls */
.vault__views {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-left: auto;
}
/* label + value + mark, the gear pane's own "Add to" recipe — so the page's two
   pickers and the pane's read as the same object rather than as lookalikes */
.vault__view {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
  color: var(--ink-2);
  transition: color var(--dur) var(--ease);
}
.vault__view:hover,
.vault__view:focus-within {
  color: var(--ink);
}
/* The total, doubling as the unit control — the editor's .totals__amount recipe at
   this page's smaller type: a relative box holding the figure and its chevron, with
   the app's own picker behind it. */
.vault__total {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-px);
  color: var(--ink-2);
}
.vault__total:hover {
  color: var(--ink);
}
/* the mark and its turn are the shared .chev (atoms/controls.scss); pointing at either
   control lights it */
.vault__total:hover .chev,
.vault__total:focus-within .chev,
.vault__view:hover .chev,
.vault__view:focus-within .chev {
  color: var(--ink);
}
.vault__count {
  margin-bottom: var(--space-2);
}

/* --- the rows --- */
/* the row itself — its rhythm, hairlines, the weight and mark columns, the trailing
   controls and their touch sizing — is VaultGearRow's; this is only the list */
.vault__list {
  display: flex;
  flex-direction: column;
}
.vault__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}
.vault__emptyacts {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.vault__none {
  padding-block: var(--space-4);
}

/* --- folders --- */
/* Everything about a folder's LOOK — the header grid, the name field, the collapse
   chevron, the trailing delete · grip cluster, the 1fr↔0fr body — comes from
   atoms/folder.scss, the same rules the editor renders. Only what's specific to a
   GEAR folder lives here. */
.folder + .folder {
  margin-top: var(--space-6);
}
/* /gear's folder header carries one thing the editor's does not: what the folder
   HOLDS. Fed in as --head-cols rather than patched into the atom — the editor's
   template is a LIST's data columns (qty · weight · class · actions), none of which
   a vault folder has, so this is exactly the "supply only what legitimately differs"
   case that hook exists for. */
.folder__head {
  /* A folder's figure is a WEIGHT, sitting directly over a column of weights, so it
     belongs in that column. The header is a grid and the rows are flex, so the only
     way they agree is for the header's trailing track to be the row's whole trailing
     cluster — the mark column, its gap, and the three buttons — and for the grid's
     own gap to be the row's gap. Written as the same arithmetic the row is built
     from rather than a measured number, so a retune of either token moves both.
     It also has to be SIZED rather than auto: Unfiled owns no actions (there is
     nothing to rename or delete about "everything else"), so an auto track
     collapsed to nothing there and ran its subtotal out past every other folder's. */
  --head-actions: calc(3 * var(--icon-btn) + 2 * var(--space-1));
  --head-cols: 1fr auto calc(var(--icon-btn) + var(--space-4) + var(--head-actions));
  gap: var(--space-4);
}
.folder__title {
  grid-column: 1;
}
.vault__foldersum {
  grid-column: 2;
  justify-self: end;
  color: var(--ink-3);
  white-space: nowrap;
}
.folder__actions {
  grid-column: 3;
}
/* ONE trailing column, shared by the header and the rows under it.
   atoms/folder.scss tunes this cluster to sit over the EDITOR's item rows: the
   glyphs are pushed to the trailing edge of their boxes, and the grip's box is
   pulled 9px left so its narrow dots land flush in the gutter. /gear's rows are a
   different grid — three centred .btn--icon glyphs — so that tuning put the
   header's three marks about 17px right of the row's three, and the two clusters
   read as two columns that nearly line up, which is worse than either. The rows own
   the geometry here, so the header takes theirs: same boxes, same centres.
   :deep, so it reaches every button in the cluster whichever component renders it
   (the move picker's is OptionMenu's, carrying ITS scope id, not this page's). */
.folder__actions :deep(.btn--icon) {
  justify-content: center;
}
.folder__grip {
  margin-left: 0;
}
.folder__grip svg {
  transform: none;
}
/* the lifted folder + its drop line, the same two states the editor shows (its own
   copies stay scoped there because they also cover the item-drag pass) */
.folder--dragging {
  opacity: 0.4;
}
/* the folder a dragged row will land in — a tint rather than an insertion line,
   because a vault folder has no slot to aim at (its rows come in the server's
   most-recently-used order) */
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
/* --- adding gear --- */
/* the add row is the next row in the list rhythm: the same top padding as a row,
   plus the rule line between them, so "Add gear" lands where the next item name
   would. The editor's FolderRows carries the identical pair for the identical
   reason — at its own --space-2 rhythm rather than this page's --space-3. */
.vault__add {
  border-top: 1px solid var(--line);
  padding-top: var(--space-3);
}
/* an EMPTY folder's add row is its FIRST row, so it drops the rule — a first row
   never carries a divider under the folder name, and it keeps the name line-free
   through the 0→1 add instead of the line jumping down under the new gear */
.vault__add--first {
  border-top: 0;
}
/* a flat view has no folder to sit inside, so its add row needs the separation the
   folder body was giving it */
.vault__add--flat {
  margin-top: var(--space-5);
}
/* the pair of fields itself is VaultAddRow — one instance per position, because a
   template ref declared inside a v-for collects into an array and could never focus
   the field it opened */
/* making a folder is typing its name — no button that invents an "Untitled folder"
   for you to hunt down and rename */
/* No rule above it. Hairlines here separate ROWS of gear from each other; this is an
   action at the foot of the page, and a seam under the last folder only drew a line
   between the gear and the thing that makes more of it. Whitespace does the
   separating, which is the house default — the hairline was the exception that had
   to earn its place, and it didn't. */
/* the .addfolder atom (controls.scss) — only its distance from the list is ours */
.vault__addfolder {
  margin-top: var(--space-6);
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
   gear, and the page shouldn't offer them with the same weight as gear you have */
.vault__removedbody .vault__row {
  opacity: 0.6;
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss). On touch
   the removed rows simply stay dimmed, which is the reading they're meant to have;
   undimming one under a finger that has moved on is the artefact. */
@media (hover: hover) and (pointer: fine) {
  .vault__removedbody .vault__row:hover {
    opacity: 1;
  }
}
/* touch: the row's controls grow to --tap inside VaultGearRow (and the search's
   clear inside SearchField); what follows them here is the folder header. */
@media (pointer: coarse) {
  /* the trailing track follows the buttons up to --tap, or the folder figures drift
     out of the weight column again on a touch screen */
  .folder__head {
    --head-actions: calc(3 * var(--tap) + 2 * var(--space-1));
  }
}

@media (max-width: $bp-stack) {
  /* the pickers drop beneath the search */
  .vault__views {
    margin-left: 0;
    gap: var(--space-3);
  }
  /* the row's own phone stack (name on its own line, the rest beneath) is
     VaultGearRow's */
  /* three header columns don't survive 375px next to three --tap buttons, so the
     subtotal takes its own line under the folder name — the way a read row's
     sub-line does */
  .folder__head {
    --head-cols: 1fr auto;
    /* the column gap set above is for the DESKTOP column alignment; once the
       subtotal drops onto its own line it reads as a sub-line of the folder name,
       and 16px of air between the two makes it look like a stray figure */
    row-gap: var(--space-1);
  }
  .folder__title {
    grid-column: 1;
    grid-row: 1;
  }
  .folder__actions {
    grid-column: 2;
    grid-row: 1;
  }
  .vault__foldersum {
    grid-column: 1;
    grid-row: 2;
    justify-self: start;
  }
}
</style>
