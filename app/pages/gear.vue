<script setup lang="ts">
import { counted, formatCount, pluralNoun } from "~~/shared/tidyText";
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Backpack03Icon, ChevronDownIcon, PlusSignIcon, Clock01Icon, GridViewIcon, ToolCaseIcon, Shapes01Icon, ListOrderedAzIcon, SortingNineOneIcon, SortingOneNineIcon, StarIcon, UndoIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import { UNITS } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { GEAR_FAMILIES, type GearGlyph } from "~~/shared/gearGlyph";
import { kitWeightMg } from "~~/shared/vaultKit";
import type { NameCommit } from "~/composables/useCatalogSearch";
import { formatPrice, sumPrices } from "~~/shared/money";
import { entryUnitFromInput, formatWeight, itemDisplayName, parseWeightInput } from "~~/shared/weights";
import {
  filterVaultRows,
  groupVaultByKind,
  searchVaultRows,
  sortVaultRows,
  vaultFamilyOf,
  vaultShownMg,
  type VaultKindSection,
  type VaultShow,
  type VaultView,
} from "~~/shared/vaultView";
import { WEIGHT_UNIT_OPTIONS } from "~/utils/unitOptions";
import { CLASS_ICONS } from "~/utils/classIcons";

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
// What "Remove" puts away is a tombstone, so a list still holding the piece can't
// undo the removal; the page doesn't list them. The ways back are the undo toast and
// adding the piece again, which lifts the tombstone (addVaultItems) and brings the
// same piece back, weight, note and kits included. A second list of gear at the foot
// of the page, there only to reverse a removal, was more page than that is worth
// (Ryan: "feels complicated").
const loading = ref(false);
const loadError = ref("");
const query = ref("");

async function loadVault() {
  if (!hasVault.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    const res = await vaultFetch<{ items: VaultEntry[] }>("/api/vault/list");
    items.value = res.items || [];
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
  },
  { immediate: true },
);

// Put a removed piece of gear back: the undo toast's way back from Remove.
async function putBack(entry: VaultEntry) {
  loadError.value = "";
  try {
    await vaultFetch("/api/vault/remove", { method: "POST", body: { id: entry.id, restore: true } });
    await loadVault();
  } catch {
    loadError.value = "Couldn’t put that back. Check your connection and try again.";
  }
}

// ---- how you're looking at it --------------------------------------------
// Two questions, two controls: WHICH gear (Show) and IN WHAT ORDER (View). Neither
// is persisted, unlike a kind's collapse state — a collapsed kind still shows its
// heading, whereas a remembered "Worn only" would greet you next visit with a gear
// that looks like it has lost most of your gear.
//
// The pipeline itself is shared/vaultView.ts: pure, and unit-tested without a
// browser, which is where the rules that are invisible until they're wrong live (the
// ranker's limit, "base means absent too", when a heading disappears).
const view = ref<VaultView>("kinds");
const show = ref<VaultShow>("all");

// ---- Gear | Kits ---------------------------------------------------------------
// Two tabs at the top, the list's own Gear / Packing / Trip bar (ModeBar) in its spot
// (Ryan: "tabs at the top for kits vs all gear. similar to how pack lists have them").
// Gear is your pieces by kind; Kits is the sets. Remembered on this device, like the
// list's mode. A piece being made into a kit (kitStarting) shows on Kits, where its
// first item will keep it.
type GearTab = "gear" | "kits";
const TAB_KEY = "gear.vault.tab.v1";
const TABS = [
  { key: "gear", label: "Gear", icon: Backpack03Icon },
  { key: "kits", label: "Kits", icon: ToolCaseIcon },
] as const;
const tab = ref<GearTab>("gear");
onMounted(() => {
  if (recall(TAB_KEY) === "kits") tab.value = "kits";
});
function pickTab(next: string) {
  tab.value = next === "kits" ? "kits" : "gear";
  remember(TAB_KEY, tab.value);
}
const isKitRow = (i: VaultEntry) => i.kind === "kit" || i.id === kitStarting.value;
const onTab = computed(() => items.value.filter((i) => isKitRow(i) === (tab.value === "kits")));

// what a kit is, it isn't base, worn or consumable: Show narrows only the Gear tab
const shown = computed(() => filterVaultRows(onTab.value, tab.value === "kits" ? "all" : show.value));
const found = computed(() => searchVaultRows(shown.value, query.value));
// A query and a View both claim the order, so one has to yield. RELEVANCE wins under
// the default view — you typed a question and the best answers belong at the top,
// which is what the ranker's cascade is for. An explicitly chosen View wins over
// relevance: you asked for heaviest first, and quietly re-ordering by match quality
// would be the page ignoring the control you just used.
const filtered = computed(() =>
  view.value === "kinds" ? found.value : sortVaultRows(found.value, view.value),
);
// A chosen order flattens, and so does a search — see groupVaultByKind for why. Kits
// are one kind of thing, so their tab is always one list.
const flat = computed(() => tab.value === "kits" || view.value !== "kinds" || !!query.value.trim());
const grouped = computed<VaultKindSection[]>(() => (flat.value ? [] : groupVaultByKind(filtered.value)));
const narrowed = computed(() => filtered.value.length !== onTab.value.length);

// The page's weight, the way the page shows it (vaultShownMg): a kit counted whole,
// its items at the counts it holds them, and a piece in a kit not counted again —
// the same in every view, so switching to A–Z doesn't change the number.
const totalMg = computed(() => vaultShownMg(filtered.value));
// The count line counts what the tab holds: pieces on Gear, kits on Kits.
const countNoun = computed(() => (tab.value === "kits" ? "kit" : "item"));

// ---- kits ----------------------------------------------------------------
// A kit opens to show its parts. Closed by default and remembered per kit on this
// device — the folder collapse's mechanism with the sense flipped: the stored flag
// means OPEN, so a kit nobody has touched stays one row. Keyed under its own prefix
// because a kit id and a folder id are both integers.
const kitOpenStore = usePersistedCollapse("gear.vkitopen.");
const kitOpen = ref<Record<number, boolean>>({});
watch(items, (list) => {
  for (const i of list) if (i.kind === "kit") kitOpen.value[i.id] = kitOpenStore.isCollapsed(i.id);
});
function toggleKit(id: number) {
  kitOpen.value[id] = kitOpenStore.toggle(id);
}
// id → shown name for every live kit, for an item's "In …" line
const kitNameById = computed(
  () => new Map(items.value.filter((i) => i.kind === "kit").map((i) => [i.id, itemDisplayName(i.brand, i.name, i.variant)])),
);
const kitNames = (entry: VaultEntry) =>
  (entry.inKits ?? []).map((id) => kitNameById.value.get(id)).filter((n): n is string => !!n);
// A part is edited where it lives — its own row, in its own folder.
function editPart(id: number) {
  const part = items.value.find((i) => i.id === id);
  if (part) openEdit(part);
}
// A kit's items are edited on its open row (VaultGearRow); each change sends the whole
// set. Shown at once — the counts, the line weights and the kit's total from what the
// page already holds — then saved, then the page re-reads, because the change touches
// OTHER rows too (each item's "In …"). A save that fails is put right by the re-read.
const kitSaving = ref<ReadonlySet<number>>(new Set());
async function setKit(entry: VaultEntry, parts: { id: number; qty: number }[], ownWeightMg: number) {
  if (kitSaving.value.has(entry.id)) return;
  const at = items.value.findIndex((i) => i.id === entry.id);
  if (at < 0) return;
  const before = items.value[at]!;
  const held = new Map((before.parts ?? []).map((p) => [p.id, p]));
  const byId = new Map(items.value.map((i) => [i.id, i]));
  const next = parts.flatMap((r) => {
    const had = held.get(r.id);
    if (had) return [{ ...had, qty: r.qty }];
    const g = byId.get(r.id);
    return g ? [{ id: g.id, qty: r.qty, brand: g.brand, name: g.name, variant: g.variant, weightMg: g.weightMg }] : [];
  });
  items.value[at] = { ...before, kind: "kit", parts: next, ownWeightMg, weightMg: kitWeightMg(ownWeightMg, next) };
  kitSaving.value = new Set([...kitSaving.value, entry.id]);
  const res = await vaultFetch<{ ok: boolean; item?: VaultEntry }>("/api/vault/items", {
    method: "POST",
    body: { op: { t: "kit", id: entry.id, parts, ownWeightMg } },
  }).catch(() => ({ ok: false }) as { ok: boolean; item?: VaultEntry });
  kitSaving.value = new Set([...kitSaving.value].filter((id) => id !== entry.id));
  if (!res.ok) loadError.value = "Couldn’t save the kit. Check your connection and try again.";
  else {
    // took something out: say what, and put it back on Undo
    const kept = new Set(parts.map((r) => r.id));
    const gone = (before.parts ?? []).filter((p) => !kept.has(p.id));
    const lostOwn = !!before.ownWeightMg && !ownWeightMg;
    if (gone.length || lostOwn) {
      const back = (before.parts ?? []).map((p) => ({ id: p.id, qty: p.qty }));
      offerUndo({
        verb: "Took",
        label: gone.length === 1 ? itemDisplayName(gone[0]!.brand, gone[0]!.name, gone[0]!.variant) : gone.length ? counted(gone.length, "item") : "its own weight",
        tail: ` out of ${itemDisplayName(before.brand, before.name, before.variant)}`,
        restore: () => setKit(items.value.find((i) => i.id === entry.id) ?? before, back, before.ownWeightMg ?? 0),
      });
    }
    // a piece that just took its first item is a kit now, and stays open where you were
    if (kitStarting.value === entry.id) {
      kitStarting.value = null;
      if (!kitOpen.value[entry.id]) toggleKit(entry.id);
    }
  }
  await loadVault();
}
// "Make it a single piece", pressed on an open kit's row: it becomes one piece weighing
// what it did, and its items stay the pieces they are.
async function unkit(id: number) {
  editing.value = null;
  const was = items.value.find((i) => i.id === id);
  const res = await vaultFetch<{ ok: boolean }>("/api/vault/items", {
    method: "POST",
    body: { op: { t: "kit", id, parts: [] } },
  }).catch(() => ({ ok: false }));
  if (!res.ok) loadError.value = "Couldn’t change that. Check your connection and try again.";
  else if (was?.parts?.length) {
    const back = was.parts.map((p) => ({ id: p.id, qty: p.qty }));
    offerUndo({
      verb: "Made",
      label: itemDisplayName(was.brand, was.name, was.variant),
      tail: " a single piece",
      restore: () => setKit(items.value.find((i) => i.id === id) ?? was, back, was.ownWeightMg ?? 0),
    });
  }
  await loadVault();
}
// "Make it a kit", pressed in a piece's dialog: the dialog closes and the piece's row
// shows its "Add an item" line, where the first item makes it a kit.
const kitStarting = ref<number | null>(null);
function startKitFor(id: number) {
  editing.value = null;
  kitStarting.value = id;
  // to the tab it will live on, so its first item doesn't carry it off the page
  pickTab("kits");
}
// "New kit", on the Kits tab: a name makes a piece, and the piece opens on its
// "Add an item" line, where the first item makes it a kit — the dialog's "Make it a
// kit" without the detour through a piece.
const newKitName = ref("");
const newKitOpen = ref(false);
const newKitEl = useTemplateRef<HTMLInputElement>("newKitEl");
function openNewKit() {
  query.value = "";
  newKitOpen.value = true;
  nextTick(() => newKitEl.value?.focus());
}
function closeNewKit() {
  newKitOpen.value = false;
  newKitName.value = "";
}
async function commitNewKit() {
  const name = newKitName.value.trim();
  if (!name || addBusy.value) return;
  addBusy.value = true;
  loadError.value = "";
  const res = await vaultFetch<{ ok: boolean; reason?: string; item?: VaultEntry }>("/api/vault/items", {
    method: "POST",
    body: { op: { t: "add", name, weightMg: 0 } },
  }).catch(() => ({ ok: false }) as { ok: boolean; reason?: string; item?: VaultEntry });
  addBusy.value = false;
  if (!res.ok || !res.item) {
    loadError.value = res.reason === "duplicate" ? "You already have that in My Gear." : "Couldn’t make that kit. Check your connection and try again.";
    return;
  }
  closeNewKit();
  kitStarting.value = res.item.id;
  await loadVault();
}
// What the gear on screen cost. Follows `filtered` like the weight beside it — both
// figures describe what you are looking at, so narrowing to Worn answers "what did
// the clothes cost" without a second control.
//
// Absent for a vault holding two currencies, which is sumPrices' rule and not a
// display decision: no figure at all beats a figure that adds pounds to dollars.
const totalPrice = computed(() => sumPrices(filtered.value));
// The money this vault keeps its prices in, when it keeps them in one — over ALL
// the gear, not the filtered view, because which currency you buy in is not a
// property of what you're currently looking at. Handed to the edit dialog so a
// price typed as a bare number joins the currency you've already stated instead of
// sitting currency-less next to a total that has one. Absent for a vault holding
// two, which is the same state that withholds the total (sumPrices).
const vaultCurrency = computed(() => sumPrices(items.value)?.currency);
// A total standing for three rows out of ninety is a true number that reads as a
// bigger claim than it is, so the figure names its own denominator — but only when
// there is one worth naming.
const priceTitle = computed(() => {
  const total = totalPrice.value;
  if (!total) return undefined;
  return total.counted === filtered.value.length
    ? "What this gear cost"
    : `What ${total.counted} of these ${filtered.value.length} pieces cost. The rest have no price.`;
});

// The line under an empty result, derived from whichever control emptied it — "no
// worn gear" and "nothing matches 'duplx'" are different facts, and one generic
// sentence would leave you guessing which control to undo.
const noneLine = computed(() => {
  if (query.value.trim()) return `Nothing here matches “${query.value.trim()}”.`;
  if (tab.value === "gear" && show.value !== "all") return `No ${show.value} gear in My Gear yet.`;
  return "";
});

// ---- kinds ---------------------------------------------------------------
// Collapse, the editor's folder mechanism: persisted per kind on this device and never
// sent to the server — it's how YOU are looking at your gear, not a fact about it.
const kindCollapse = usePersistedCollapse("gear.vkind.");
const kindCollapsed = ref<Record<string, boolean>>({});
watch(grouped, (sections) => {
  for (const s of sections) if (!(s.key in kindCollapsed.value)) kindCollapsed.value[s.key] = kindCollapse.isCollapsed(s.key);
});
function toggleKind(key: string) {
  kindCollapsed.value[key] = kindCollapse.toggle(key);
}

// A row's menus are absolutely positioned and .folder__bodyinner clips (overflow:
// hidden, for the collapse animation), so a menu opened on the last row of a section
// was guillotined. Count the open overlays per section and lift the clip while any is,
// exactly as FolderSection does for its own rows.
const overlays = ref<Record<string, number>>({});
function onOverlayToggle(key: string, open: boolean) {
  overlays.value[key] = Math.max(0, (overlays.value[key] ?? 0) + (open ? 1 : -1));
}

// ---- adding gear by hand -------------------------------------------------
// The half capture can't do. Gear arrives here on its own from every list you build,
// which covers the common case beautifully and answers nothing at all for the pack
// you bought yesterday and haven't packed yet.
//
// One add row for the page, under the count: with no folders there is nowhere to
// choose, and the piece lands under its kind by itself. Press-to-open: a quiet label,
// not an empty form the page is waiting on.
const adding = ref(false);
const addName = ref("");
const addWeight = ref("");
const addBusy = ref(false);
type AddRow = { focus: () => void };
// one mounted at a time: the page's, or the empty state's
const addRow = useTemplateRef<AddRow | AddRow[]>("addRow");

function openAdd() {
  adding.value = true;
  addName.value = "";
  addWeight.value = "";
}
function closeAdd() {
  adding.value = false;
  addName.value = "";
  addWeight.value = "";
}
async function commitAdd() {
  const name = addName.value.trim();
  if (!name || addBusy.value) return;
  const raw = addWeight.value.trim();
  const weightMg = raw ? parseWeightInput(raw, unit.value) : 0;
  if (weightMg == null) {
    loadError.value = "That weight doesn’t read as a number. Try “540 g” or “1.2 kg”.";
    return;
  }
  // Only the pair that was sent is cleared: the fields stay live through the round
  // trip, and anything typed meanwhile is the next one.
  // a weight typed with its unit ("3.8 oz") reads back in that unit on the row
  const entryUnit = entryUnitFromInput(raw) ?? undefined;
  await sendAdd({ t: "add", name, weightMg, entryUnit }, () => addName.value.trim() === name && addWeight.value.trim() === raw);
}
// A catalog product picked from the add row's suggestions, added AS that product: its
// brand, size, gear type, catalog link and calories, and its weight unless you typed
// your own beside it (the weight you measured is the one My Gear keeps).
async function commitPick(c: NameCommit) {
  if (addBusy.value) return;
  const raw = addWeight.value.trim();
  const typed = raw ? parseWeightInput(raw, unit.value) : null;
  if (raw && typed == null) {
    loadError.value = "That weight doesn’t read as a number. Try “540 g” or “1.2 kg”.";
    return;
  }
  // the name field emptied itself on the pick, so "unchanged" is: still empty
  await sendAdd(
    {
      t: "add",
      brand: c.brand,
      name: c.name,
      variant: c.variant,
      commonName: c.commonName,
      weightMg: typed ?? c.weightMg ?? 0,
      // your own typed weight keeps the unit you typed it in, like a plain add
      entryUnit: (typed != null && entryUnitFromInput(raw)) || undefined,
      classification: c.classification,
      kcal: c.kcal,
      catalogItemId: c.catalogItemId,
    },
    () => !addName.value.trim() && addWeight.value.trim() === raw,
  );
}
async function sendAdd(op: Record<string, unknown>, unchanged: () => boolean) {
  addBusy.value = true;
  loadError.value = "";
  try {
    const res = await vaultFetch<{ ok: boolean; reason?: string; item?: VaultEntry }>("/api/vault/items", {
      method: "POST",
      body: { op },
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
    if (res.item) offerAdded(res.item);
    // Committing re-opens a fresh pair — the editor's `advance` behaviour, which is
    // what makes typing in five things bearable rather than five separate presses.
    if (unchanged()) {
      addName.value = "";
      addWeight.value = "";
      // the whole gear re-rendered under it, so the field is a new element
      nextTick(() => [addRow.value ?? []].flat()[0]?.focus());
    }
  } catch {
    loadError.value = "Couldn’t add that. Check your connection and try again.";
  }
  addBusy.value = false;
}

// A piece sorts itself into its kind, often far down the page or into a collapsed
// section, so the add row reset under a piece that had silently gone somewhere else
// (the 2026-11-08 UX audit's first finding). Say where, with the way back. No scroll:
// the add row stays where you are typing the next one. Undo is a put-away, the only
// removal there is (a tombstone; see remove.post.ts), so it waits under Removed gear.
function offerAdded(item: VaultEntry) {
  const kind = vaultFamilyOf(item);
  offerUndo({
    verb: "Added",
    label: itemDisplayName(item.brand, item.name, item.variant),
    tail: ` to ${GEAR_FAMILIES.find((f) => f.key === kind)?.label ?? "Other"}`,
    restore: async () => {
      await vaultFetch("/api/vault/remove", { method: "POST", body: { id: item.id } }).catch(() => {});
      await loadVault();
    },
  });
}

// ---- editing in place ----------------------------------------------------
// The dialog is Lazy + v-if on "has it ever opened", so its chunk never loads for
// someone who only came to look — the LazyCatalogCorrectionModal idiom.
const editing = ref<VaultEntry | null>(null);
const editorEverOpened = useLatch(() => editing.value);
// The brands and gear types your gear already uses, most used first: the dialog suggests
// them ahead of the catalog's under Brand and Gear type.
const knownVocab = computed(() => {
  const rank = (values: (string | undefined)[]) => {
    const n = new Map<string, number>();
    for (const v of values) if (v?.trim()) n.set(v.trim(), (n.get(v.trim()) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
  };
  return { brands: rank(items.value.map((i) => i.brand)), types: rank(items.value.map((i) => i.commonName)) };
});
function openEdit(entry: VaultEntry) {
  editing.value = entry;
}
// One field picked on a row — a piece's own unit, or its icon — the way a list row
// takes it: shown at once, then saved. The server's answer replaces the row; a save
// that fails puts the old value back.
async function patchEntry(
  entry: VaultEntry,
  patch: Pick<VaultEntry, "entryUnit"> | Pick<VaultEntry, "name"> | { icon: VaultEntry["icon"] | null },
  what: string,
) {
  const at = items.value.findIndex((i) => i.id === entry.id);
  if (at < 0) return;
  const before = items.value[at]!;
  items.value[at] = { ...before, ...patch, icon: "icon" in patch ? (patch.icon ?? undefined) : before.icon };
  const put = (row: VaultEntry) => {
    const i = items.value.findIndex((x) => x.id === row.id);
    if (i >= 0) items.value[i] = row;
  };
  const res = await vaultFetch<{ ok: boolean; item?: VaultEntry }>("/api/vault/items", {
    method: "POST",
    body: { op: { t: "edit", id: entry.id, patch } },
  }).catch(() => ({ ok: false }) as { ok: boolean; item?: VaultEntry });
  if (res.ok && res.item) return put(res.item);
  put(before);
  loadError.value = `Couldn’t save that ${what}. Check your connection and try again.`;
}
// a kit's name, typed on its open row (the only thing about a kit a dialog held)
function renameKit(entry: VaultEntry, name: string) {
  void patchEntry(entry, { name }, "name");
}
function setEntryUnit(entry: VaultEntry, u: Unit) {
  if (entry.entryUnit !== u) void patchEntry(entry, { entryUnit: u }, "unit");
}
// A new icon can move the piece to another kind, and so out from under your pointer:
// when it does, say where it went, with the way back.
async function setEntryIcon(entry: VaultEntry, glyph: GearGlyph | null) {
  const was = entry.icon ?? null;
  if (was === glyph) return;
  const from = vaultFamilyOf(entry);
  const to = vaultFamilyOf({ ...entry, icon: glyph ?? undefined });
  await patchEntry(entry, { icon: glyph }, "icon");
  if (from === to || (items.value.find((i) => i.id === entry.id)?.icon ?? null) !== glyph) return;
  offerUndo({
    verb: "Moved",
    label: itemDisplayName(entry.brand, entry.name, entry.variant),
    tail: ` to ${GEAR_FAMILIES.find((f) => f.key === to)?.label ?? "Other"}`,
    restore: () => patchEntry({ ...entry, icon: glyph ?? undefined }, { icon: was }, "icon"),
  });
}
// Patch the one row in place rather than re-reading the vault: the endpoint returns
// the row as it now stands, and a full reload would re-sort the page under a dialog
// that just closed (a rename can move a row under A–Z). Changing a kit's parts is the
// exception: it changes OTHER rows too (each item's "In …"), so the page re-reads.
function onItemSaved(item: VaultEntry) {
  const at = items.value.findIndex((i) => i.id === item.id);
  const was = at >= 0 ? items.value[at]! : null;
  if (at >= 0) items.value[at] = item;
  editing.value = null;
  // owning fewer than a kit held brings the kit down to it (the vault does that), so
  // the kits it is in read again
  if (item.inKits?.length && (item.owned ?? 1) < (was?.owned ?? 1)) void loadVault();
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
  const saved = recall(UNIT_KEY);
  if (saved && (UNITS as string[]).includes(saved)) {
    unit.value = saved as Unit;
    return;
  }
  const legacy = recall(LEGACY_SYSTEM_KEY);
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
// The undo bar: a toast that holds what happened and how to take it back, rather than
// a line of text — ten seconds, the timer cleared on unmount, the editor's own shape.
// Every change here that takes something away offers it: a piece removed, an item
// taken out of a kit, a kit made a single piece (Ryan: "we should audit for toasts
// that don't allow undo").
type Undo = { verb: string; label: string; tail?: string; restore: () => Promise<void> | void };
const { toast: undoable, flash: offerUndo, clear: clearUndo } = useToast<Undo>(10_000);

async function remove(entry: VaultEntry) {
  removing.value = entry.id;
  loadError.value = "";
  try {
    await vaultFetch("/api/vault/remove", { method: "POST", body: { id: entry.id } });
    items.value = items.value.filter((i) => i.id !== entry.id);
    offerUndo({ verb: "Removed", label: itemDisplayName(entry.brand, entry.name, entry.variant), restore: () => putBack(entry) });
  } catch {
    loadError.value = "Couldn’t remove that. Check your connection and try again.";
  }
  removing.value = null;
}

async function undo() {
  const u = undoable.value;
  if (!u) return;
  clearUndo();
  await u.restore();
}

// Sign in without losing the vault behind it — the account opens over this page.
const { open: openAccount } = useAccountModal();
// The page's own order. A–Z / Heaviest / Lightest wear sort glyphs (A–Z the ordered
// list with A over Z); By kind takes a grid mark because it is a LAYOUT, not a sort
// key, and shouldn't borrow one.
const VIEW_OPTIONS = [
  { key: "kinds", label: "By kind", icon: Shapes01Icon },
  { key: "az", label: "A–Z", icon: ListOrderedAzIcon },
  { key: "heaviest", label: "Heaviest", icon: SortingNineOneIcon },
  { key: "lightest", label: "Lightest", icon: SortingOneNineIcon },
  { key: "recent", label: "Recently used", icon: Clock01Icon },
  { key: "most", label: "Most used", icon: StarIcon },
];
// Marked like the View menu beside it: the classes wear the marks the rows carry.
const SHOW_OPTIONS = [
  { key: "all", label: "All gear", icon: GridViewIcon },
  { key: "base", label: "Base", icon: CLASS_ICONS.base },
  { key: "worn", label: "Worn", icon: CLASS_ICONS.worn },
  { key: "consumable", label: "Consumable", icon: CLASS_ICONS.consumable },
];
// Each trigger wears its current option's mark in place of a "View" / "Show" word: the
// values already say which question they answer (Heaviest is an order, Worn a filter),
// and the mark is the one the open menu puts beside the same row.
const viewOption = computed(() => VIEW_OPTIONS.find((o) => o.key === view.value) ?? VIEW_OPTIONS[0]!);
const showOption = computed(() => SHOW_OPTIONS.find((o) => o.key === show.value) ?? SHOW_OPTIONS[0]!);

// ---- taking it with you --------------------------------------------------
// My Gear is the one thing an account holds rather than a link, which makes it the
// one thing you can't already take with you by copying a URL — and until this, the
// only account-level data operation was delete.
//
// ALL of it, not what the controls have narrowed to: View and Show are how you're
// looking at your gear, and a file called my-gear that quietly held only the worn
// half would be a worse answer than no file. `items` is the live gear — what
// "Remove" put away isn't loaded at all, which is the answer you'd want from a file
// called my-gear.
//
// The exporter is imported on demand, like the list's four: someone who never
// exports shouldn't download the code that formats a CSV. Warmed when the menu
// opens and awaited when a row is pressed — a warmed import() resolves from module
// cache in a microtask, so the row doesn't sit there while a chunk is fetched.
// (useListExports warms for the same reason, with a sharper one behind it: its
// clipboard writes must stay inside iOS Safari's user-gesture window.)
const exporter = () => import("~~/shared/exporters/vault");
function warmExport() {
  void exporter();
}
// The ⋯'s three rows. Import is a dialog rather than a download, so the menu's one
// emit forks here instead of the menu knowing which of its rows is which kind.
const importOpen = ref(false);
const importEverOpened = useLatch(() => importOpen.value);
function onMenuPick(action: string) {
  if (action !== "import") return void exportGear(action);
  importOpen.value = true;
}

async function exportGear(kind: string) {
  loadError.value = "";
  try {
    const { vaultToCsv, vaultToJson } = await exporter();
    const gear = { items: items.value };
    if (kind === "json") {
      downloadFile("my-gear.json", vaultToJson(gear), "application/json");
    } else {
      downloadFile("my-gear.csv", vaultToCsv(gear, unit.value), "text/csv");
    }
  } catch {
    // the chunk can fail to load (offline before the SW cached it) — the page's own
    // error line, rather than a silent no-op on a button you just pressed
    loadError.value = "Couldn’t build that file. Check your connection and try again.";
  }
}
</script>

<template>
  <div>
    <!-- compact: the bar's trailing group is now a glyph row behind one text action
         — the read views' exact shape, which is what the flag is for. Without it the
         looser gaps ran "Create a list" onto two lines at 375px once the ⋯ arrived,
         and the account control changed between a word and a glyph with the session. -->
    <!-- No page label: the Gear / Kits tabs under the bar say where you are, and the
         h1 below keeps the page's name for the outline. -->
    <SiteTopbar compact>
      <!-- Not the wordmark: the editor's own "Your packs" switcher, in the spot it holds
           on a list, so the two bars read alike and every list is one tap away (the
           wordmark only went home). Client-only: the lists it names live in this
           browser and the account, and the server has neither. The fallback holds its
           width so "My Gear" doesn't jump when it arrives. -->
      <template #lead>
        <ClientOnly>
          <ListMenu :current-share-code="null" @new-list="navigateTo('/e')" />
          <template #fallback><span class="gear__leadhold" aria-hidden="true">Your packs</span></template>
        </ClientOnly>
      </template>
      <!-- The bar's end-cap, where every ⋯ on the site sits — after the account
           control (see SiteTopbar's #end). It leads with "Create a list", which used to
           be a word in the bar and crowded it, then holds the import and export, which
           are actions on the whole page rather than ways of looking at it, so they don't
           belong beside View and Show.
           Present for everyone: signed out it is only the way to a new list. Import
           needs an account, and works on an empty vault (restoring a backup onto a new
           machine is the case with nothing to export); the DOWNLOAD rows are the ones
           gated on having gear (canExport): a control worth no action is absent, not
           inert.
           ClientOnly for the reason the page body is: the server has no session, and
           a signed-in browser hydrates with one, so a v-if on it mismatches. -->
      <template #end>
        <ClientOnly>
          <VaultMenu
            :signed-in="hasVault"
            :can-export="hasVault && items.length > 0"
            @open="warmExport"
            @pick="onMenuPick"
          />
        </ClientOnly>
      </template>
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
          <p class="vault__sentline">{{ VAULT_ASK }}</p>
          <button type="button" class="btn btn--primary" @click="openAccount">Sign in</button>
        </div>

        <!-- the gear -->
        <div v-else>
          <!-- the tabs, and opposite them the one way to add to what the tab holds —
               a piece on Gear, a kit on Kits. The field it opens sits at the head of
               the list, where the new row will land. -->
          <div class="vault__tabbar">
            <ModeBar :modes="TABS" :current="tab" label="My Gear view" @pick="pickTab" />
            <button v-if="tab === 'kits'" type="button" class="btn btn--quiet ink-quiet vault__tabadd" @click="openNewKit">
              <HugeiconsIcon :icon="PlusSignIcon" :size="16" :stroke-width="2" aria-hidden="true" />
              New kit
            </button>
            <button v-else type="button" class="btn btn--quiet ink-quiet vault__tabadd" @click="query = ''; openAdd()">
              <HugeiconsIcon :icon="PlusSignIcon" :size="16" :stroke-width="2" aria-hidden="true" />
              Add gear
            </button>
          </div>
          <!-- the gear you pack most, as tiles, above everything else (hidden while
               you search: a query is a question about rows). A tile opens the piece. -->
          <VaultMostUsed
            v-if="tab === 'gear' && !query.trim()"
            :items="items"
            :unit="unit"
            @open="(entry: VaultEntry) => openEdit(entry)"
          />

          <!-- Nothing to search, order or narrow until there IS gear — three
               controls over "Nothing here yet" is furniture for a room with no
               floor. -->
          <div v-if="items.length" class="vault__bar">
            <!-- the field and its own clear — SearchField, the same control the gear
                 pane draws; only the sizing is this page's -->
            <SearchField
              v-model="query"
              class="vault__searchwrap"
              :placeholder="tab === 'kits' ? 'Search kits…' : 'Search gear…'"
              :label="tab === 'kits' ? 'Search kits' : 'Search gear'"
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
                  <HugeiconsIcon :icon="viewOption.icon" class="vault__viewmark" :size="16" :stroke-width="2" aria-hidden="true" />
                  <span class="vault__viewword">{{ viewOption.label }}</span>
                  <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2.25" aria-hidden="true" />
                </template>
              </OptionMenu>
              <OptionMenu
                v-if="tab === 'gear'"
                class="vault__view"
                :options="SHOW_OPTIONS"
                :current="show"
                label="Which gear to show"
                @pick="(k) => (show = k as VaultShow)"
              >
                <template #trigger="{ open }">
                  <HugeiconsIcon :icon="showOption.icon" class="vault__viewmark" :size="16" :stroke-width="2" aria-hidden="true" />
                  <span class="vault__viewword">{{ showOption.label }}</span>
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

          <template v-else-if="items.length">
            <p class="t-sm t-muted vault__count">
              <template v-if="narrowed">{{ formatCount(filtered.length) }} of {{ formatCount(onTab.length) }}</template>
              <template v-else>{{ formatCount(onTab.length) }}</template>
              {{ pluralNoun(onTab.length, countNoun) }} ·
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
              <!-- What it cost, after what it weighs — the closet's second number, and
                   the reason a price is worth recording at all. Plain text, not a
                   control: the weight opens a unit picker because there IS a choice
                   about units, and there is no equivalent choice here. -->
              <template v-if="totalPrice">
                · <span class="t-num" :title="priceTitle">{{ formatPrice(totalPrice.cents, totalPrice.currency) }}</span>
              </template>
            </p>

            <!-- the page's one add row, at the head of the gear: with no folders there
                 is nowhere to choose, and a piece lands under its kind by itself -->
            <!-- Kits: name a new one, and it opens on its "Add an item" line -->
            <form v-if="!query && tab === 'kits' && newKitOpen" class="vault__add vault__add--top vault__newkit" @submit.prevent="commitNewKit">
              <input
                ref="newKitEl"
                v-model="newKitName"
                class="field"
                placeholder="New kit"
                aria-label="Name a new kit"
                autocomplete="off"
                :maxlength="200"
                :disabled="addBusy"
                @keydown.esc="closeNewKit"
                @blur="!newKitName.trim() && closeNewKit()"
              />
            </form>
            <div v-else-if="!query && tab === 'gear' && adding" class="vault__add vault__add--top">
              <VaultAddRow
                ref="addRow"
                v-model:name="addName"
                v-model:weight="addWeight"
                :unit="unit"
                :busy="addBusy"
                @submit="commitAdd"
                @pick="commitPick"
                @done="closeAdd"
              />
            </div>

            <!-- FLAT: a chosen order, or a search. One list, one order, no headings —
                 a folder already owns an order of its own, and two authorities over
                 the same rows is what makes "heaviest" mean nothing. -->
            <!-- the row is VaultGearRow, the same one a kind's list draws -->
            <ul v-if="flat" class="vault__list">
              <VaultGearRow
                v-for="entry in filtered"
                :key="entry.id"
                :entry="entry"
                :unit="unit"
                :busy="removing === entry.id"
                :open="!!kitOpen[entry.id]"
                :kit-names="kitNames(entry)"
                :gear="items"
                :kit-busy="kitSaving.has(entry.id)"
                :start-kit="kitStarting === entry.id"
                @toggle="toggleKit(entry.id)"
                @edit-part="editPart"
                @kit="(parts: { id: number; qty: number }[], own: number) => setKit(entry, parts, own)"
                @cancel-kit="kitStarting = null"
                @rename="(n: string) => renameKit(entry, n)"
                @unkit="unkit(entry.id)"
                @edit="openEdit(entry)"
                @remove="remove(entry)"
                @unit="(u: Unit) => setEntryUnit(entry, u)"
                @icon="(g: GearGlyph | null) => setEntryIcon(entry, g)"
              />
            </ul>

            <!-- BY KIND. The editor's folder, class for class — the header grid, the
                 collapse chevron and the 1fr↔0fr body all come from atoms/folder.scss —
                 with a kind's name for a heading: nothing to rename, delete or drag,
                 because nobody filed anything. -->
            <template v-else>
              <section
                v-for="section in grouped"
                :key="section.key"
                class="folder"
                :data-collapsed="kindCollapsed[section.key] ? true : null"
              >
                <header class="folder__head">
                  <div class="folder__title">
                    <h2 class="field folder__name vault__kind">{{ section.label }}</h2>
                    <NestChevron
                      folder
                      :collapsed="!!kindCollapsed[section.key]"
                      :label="section.label"
                      @toggle="toggleKind(section.key)"
                    />
                  </div>
                </header>

                <div class="folder__body">
                  <div class="folder__bodyinner" :class="{ 'is-overlay-open': (overlays[section.key] ?? 0) > 0 }">
                    <ul class="vault__list">
                      <VaultGearRow
                        v-for="entry in section.entries"
                        :key="entry.id"
                        :entry="entry"
                        :unit="unit"
                        :busy="removing === entry.id"
                        :open="!!kitOpen[entry.id]"
                        :kit-names="kitNames(entry)"
                        :gear="items"
                        :kit-busy="kitSaving.has(entry.id)"
                        :start-kit="kitStarting === entry.id"
                        @toggle="toggleKit(entry.id)"
                        @edit-part="editPart"
                        @kit="(parts: { id: number; qty: number }[], own: number) => setKit(entry, parts, own)"
                        @cancel-kit="kitStarting = null"
                        @rename="(n: string) => renameKit(entry, n)"
                        @unkit="unkit(entry.id)"
                        @edit="openEdit(entry)"
                        @remove="remove(entry)"
                        @unit="(u: Unit) => setEntryUnit(entry, u)"
                        @icon="(g: GearGlyph | null) => setEntryIcon(entry, g)"
                        @overlay-toggle="(o: boolean) => onOverlayToggle(section.key, o)"
                      />
                    </ul>
                  </div>
                </div>
              </section>
            </template>

            <!-- a filter or a search that matched nothing. The line names the control
                 that emptied the page, so you know which one to undo. -->
            <p v-if="!filtered.length && noneLine" class="t-muted vault__none">{{ noneLine }}</p>
            <p v-else-if="tab === 'kits' && !onTab.length" class="t-muted vault__none">
              No kits yet. Name one above, or open a piece and choose Make it a kit.
            </p>

          </template>

          <!-- Nothing at all: no gear yet. Adding is offered FIRST — the
               capture sentence is still true and still the faster path, but it
               answers "how does gear get here eventually", not "how do I put the
               pack I bought yesterday in". -->
          <div v-else class="vault__empty">
            <p class="t-muted">
              Nothing here yet. Add a piece of gear, or build a list and it’ll collect
              itself here.
            </p>
            <VaultAddRow
              v-if="adding"
              ref="addRow"
              v-model:name="addName"
              v-model:weight="addWeight"
              :unit="unit"
              :busy="addBusy"
              @submit="commitAdd"
              @pick="commitPick"
              @done="closeAdd"
            />
            <div v-else class="vault__emptyacts">
              <button type="button" class="btn btn--primary" @click="openAdd">Add gear</button>
              <NuxtLink to="/e" class="btn btn--ghost">Create a list</NuxtLink>
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
      :default-currency="vaultCurrency"
      :known="knownVocab"
      @close="editing = null"
      @saved="onItemSaved"
      @make-kit="startKitFor"
    />

    <!-- Same lazy idiom: nobody who never imports downloads the parser. -->
    <LazyVaultImportModal
      v-if="importEverOpened"
      :open="importOpen"
      @close="importOpen = false"
      @imported="loadVault"
    />

    <!-- Removal lands as the site's undo toast, the same object the editor puts up
         when you remove an item — same surface, same "Removed <thing> · Undo"
         shape, same place on screen. -->
    <Transition name="toast">
      <div v-if="undoable" class="toast undobar">
        <span class="t-sm">
          {{ undoable.verb }} <strong>{{ undoable.label }}</strong>{{ undoable.tail ?? "" }}
        </span>
        <button class="undobar__btn t-sm" @click="undo">
          <HugeiconsIcon :icon="UndoIcon" :size="14" :stroke-width="2" /> Undo
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
/* the switcher's width before it hydrates: its word and chevron, unseen */
.gear__leadhold {
  visibility: hidden;
  padding-inline-end: calc(14px + var(--space-1));
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
/* mark + value + chevron: the current option's own mark stands where a "View" /
   "Show" word used to, since the values already say which question they answer */
.vault__view {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  white-space: nowrap;
  color: var(--ink-2);
  transition: color var(--spring-fade-dur) var(--spring-fade);
}
.vault__view:focus-within {
  color: var(--ink);
}
/* a step quieter than the value beside it, as the word it replaced was */
.vault__viewmark {
  flex: none;
  color: var(--ink-3);
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
/* the mark and its turn are the shared .chev (atoms/controls.scss); focus on either
   control lights it, and so does the pointer (below) */
.vault__total:focus-within .chev,
.vault__view:focus-within .chev {
  color: var(--ink);
}
/* Pointer-gated, like every hover on this page that paints, ink included: on touch
   a tap leaves :hover latched on the picker after its menu has closed, a lit control
   nothing is pointing at. Focus (the rules above) is what touch and keys get. */
@media (hover: hover) and (pointer: fine) {
  .vault__view:hover,
  .vault__view:hover .chev,
  .vault__total:hover,
  .vault__total:hover .chev {
    color: var(--ink);
  }
}
/* Proportional figures, the text's own: tabular ones kept the total from shuffling
   sideways as a search's "12 of 340" changed, but set every digit monospace-wide on a
   line read far more often at rest than mid-search, and went in review. */
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

/* --- kinds --- */
/* A kind's LOOK — the header grid, the collapse chevron, the 1fr↔0fr body — comes
   from atoms/folder.scss, the same rules the editor's folders render. A kind has no
   buttons of its own (nothing to rename, delete or drag), so its header is the name
   and the chevron alone. */
.folder + .folder {
  margin-top: var(--space-6);
}
.folder__head {
  --head-cols: 1fr;
  gap: var(--space-4);
}
.folder__title {
  grid-column: 1;
}
/* a heading, not an editable name: it borrows the name field's type so it sits where
   a folder's name sat, without being a field */
.vault__kind {
  margin: 0;
  color: var(--ink);
  cursor: default;
}
/* --- adding gear --- */
/* the page's one add row, between the count and the gear: the list's own spacing,
   no rule above it (nothing above it is a row of gear) */
.vault__add--top {
  margin-bottom: var(--space-4);
}
/* The list's mode bar, in the list's exact spot: the editor's body pads its top by
   --space-1 (.editor__body), a page by --space-5 (.page), so the row is pulled up by
   the difference and its first tab lands where the list's does, 8px under the bar.
   A flex row, as the list's column is, so the margin isn't eaten by a line box. */
.vault__tabbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: calc(var(--space-1) - var(--space-5));
  margin-bottom: var(--space-3);
}
.vault__tabadd {
  flex: none;
  gap: var(--space-1);
}

@media (max-width: $bp-stack) {
  /* the pickers keep the trailing edge here too, beside the search or on their own
     line beneath it; only their gap tightens */
  .vault__views {
    gap: var(--space-3);
  }
  /* and the search drops its cap, so it ends on that same edge rather than short of it */
  .vault__searchwrap {
    max-width: none;
  }
  /* The pickers keep their mark and chevron and drop the word, so they fit on the
     search's own line instead of taking one of their own: a line of a phone's first
     screen spent on two controls you rarely touch. Their names stay on aria-label. */
  .vault__viewword {
    display: none;
  }
  .vault__bar {
    flex-wrap: nowrap;
  }
  /* the row's own phone stack (name on its own line, the rest beneath) is
     VaultGearRow's */
}
</style>
