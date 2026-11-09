<script setup lang="ts">
import { counted, formatCount, pluralNoun } from "~~/shared/tidyText";
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Backpack03Icon, ChevronDownIcon, PlusSignIcon, Clock01Icon, ToolCaseIcon, Shapes01Icon, ListOrderedAzIcon, SortingNineOneIcon, SortingOneNineIcon, StarIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import { UNITS } from "~~/shared/types";
import type { VaultEntry, VaultItemOp } from "~~/shared/vault";
import { gearFamilyLabel, type GearGlyph } from "~~/shared/gearGlyph";
import { kitPartRefs, kitWeightMg } from "~~/shared/vaultKit";
import { formatPrice, sumPrices } from "~~/shared/money";
import { itemDisplayName } from "~~/shared/weights";
import {
  vaultSections,
  searchVaultRows,
  sortVaultRows,
  vaultFamilyOf,
  type VaultView,
} from "~~/shared/vaultView";

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
// One control, the order (View); not persisted. There was a second, WHICH gear (all,
// base, worn, consumable), and it went (2026-11-08): worn and consumable are facts about
// a list, most gear in My Gear carries no class at all, and the kinds already put the
// clothing and the food apart.
//
// The pipeline itself is shared/vaultView.ts: pure, and unit-tested without a
// browser, which is where the rules that are invisible until they're wrong live (the
// ranker's limit, when a heading disappears).
const view = ref<VaultView>("kinds");

// ---- Gear | Kits ---------------------------------------------------------------
// Two tabs at the top, the list's own Gear / Packing / Trip bar (ModeBar) in its spot
// (Ryan: "tabs at the top for kits vs all gear. similar to how pack lists have them").
// Gear is your pieces by kind; Kits is the sets. Remembered on this device, like the
// list's mode.
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
const onTab = computed(() => items.value.filter((i) => (i.kind === "kit") === (tab.value === "kits")));
const found = computed(() => searchVaultRows(onTab.value, query.value));
// A query and a View both claim the order, so one has to yield. RELEVANCE wins under
// the default view — you typed a question and the best answers belong at the top,
// which is what the ranker's cascade is for. An explicitly chosen View wins over
// relevance: you asked for heaviest first, and quietly re-ordering by match quality
// would be the page ignoring the control you just used.
const filtered = computed(() =>
  view.value === "kinds" ? found.value : sortVaultRows(found.value, view.value),
);
// A chosen order flattens the Gear tab, and so does a search — see groupVaultByKind.
const flat = computed(() => view.value !== "kinds" || !!query.value.trim());
// The Gear tab's sections: a kind each, or — for a chosen order or a search — one list
// with no heading, so the page draws its rows in one place either way.
const sections = computed(() => vaultSections(filtered.value, flat.value));
const narrowed = computed(() => filtered.value.length !== onTab.value.length);

// The count line counts what the tab holds: pieces on Gear, kits on Kits.
const countNoun = computed(() => (tab.value === "kits" ? "kit" : "item"));

// ---- kits ----------------------------------------------------------------
// Every piece by id: a kit section's item rows and its owned counts read from it.
const gearById = computed(() => new Map(items.value.map((i) => [i.id, i])));
// id → "Cook kit, Fire kit" for a piece's "In …" line: one string per row, so it
// compares by value and a page render doesn't hand every row a fresh array
const inKitsById = computed(() => {
  const names = new Map(items.value.filter((i) => i.kind === "kit").map((i) => [i.id, itemDisplayName(i.brand, i.name, i.variant)]));
  const out = new Map<number, string>();
  for (const i of items.value) {
    const label = (i.inKits ?? []).map((id) => names.get(id)).filter(Boolean).join(", ");
    if (label) out.set(i.id, label);
  }
  return out;
});
// A kit's items are edited in its section (VaultKitSection); each change sends the whole
// set. Shown at once — the counts, the line weights and the kit's total from what the
// page already holds — then saved, and the vault's answer put in place (putKit), with
// each item's "In …" kept in step. No re-read of the whole gear for a stepper press;
// only a save that fails reloads, to put the page right.
const kitSaving = reactive(new Set<number>());
// Every change to a row is one op to /api/vault/items. Never throws: a failed request
// answers { ok: false }, as a refusal does, and each caller says what failed.
type OpResult = { ok: boolean; reason?: string; item?: VaultEntry };
const vaultOp = (op: VaultItemOp): Promise<OpResult> =>
  vaultFetch<OpResult>("/api/vault/items", { method: "POST", body: { op } }).catch(() => ({ ok: false }));
// The kit as the vault now has it, in place (first, when it's new), and every piece's
// "In …" kits brought in line with what it holds: the one change a kit's save makes to
// rows other than its own.
function putKit(kit: VaultEntry) {
  const holds = new Set(kit.kind === "kit" ? (kit.parts ?? []).filter((p) => !p.removed).map((p) => p.id) : []);
  const next = items.value.map((i) => {
    if (i.id === kit.id) return kit;
    if (i.kind === "kit") return i;
    const was = i.inKits ?? [];
    const had = was.includes(kit.id);
    const has = holds.has(i.id);
    if (had === has) return i;
    const inKits = has ? [...was, kit.id].sort((a, b) => a - b) : was.filter((k) => k !== kit.id);
    return { ...i, inKits: inKits.length ? inKits : undefined };
  });
  items.value = next.some((i) => i.id === kit.id) ? next : [kit, ...next];
}
async function setKit(entry: VaultEntry, parts: { id: number; qty: number }[], ownWeightMg: number) {
  if (kitSaving.has(entry.id)) return;
  if (entry.id === DRAFT_ID) return void saveDraftKit(entry.name, parts);
  const at = items.value.findIndex((i) => i.id === entry.id);
  if (at < 0) return;
  const before = items.value[at]!;
  const held = new Map((before.parts ?? []).map((p) => [p.id, p]));
  const next = parts.flatMap((r) => {
    const had = held.get(r.id);
    if (had) return [{ ...had, qty: r.qty }];
    const g = gearById.value.get(r.id);
    return g ? [{ id: g.id, qty: r.qty, brand: g.brand, name: g.name, variant: g.variant, weightMg: g.weightMg }] : [];
  });
  items.value[at] = { ...before, kind: "kit", parts: next, ownWeightMg, weightMg: kitWeightMg(ownWeightMg, next) };
  kitSaving.add(entry.id);
  const res = await vaultOp({ t: "kit", id: entry.id, parts, ownWeightMg });
  kitSaving.delete(entry.id);
  if (!res.ok || !res.item) {
    loadError.value = "Couldn’t save the kit. Check your connection and try again.";
    return void loadVault();
  }
  putKit(res.item);
  // took something out: say what, and put it back on Undo
  const kept = new Set(parts.map((r) => r.id));
  const gone = (before.parts ?? []).filter((p) => !kept.has(p.id));
  const lostOwn = !!before.ownWeightMg && !ownWeightMg;
  if (gone.length || lostOwn) {
    const back = kitPartRefs(before.parts ?? []);
    offerUndo({
      verb: "Took",
      label: gone.length === 1 ? itemDisplayName(gone[0]!.brand, gone[0]!.name, gone[0]!.variant) : gone.length ? counted(gone.length, "item") : "its own weight",
      tail: ` out of ${itemDisplayName(before.brand, before.name, before.variant)}`,
      restore: () => setKit(items.value.find((i) => i.id === entry.id) ?? before, back, before.ownWeightMg ?? 0),
    });
  }
}
// A new kit's first item: make the piece, then make it a kit of that item, then show
// the kit where the draft was.
async function saveDraftKit(name: string, parts: { id: number; qty: number }[]) {
  kitSaving.add(DRAFT_ID);
  loadError.value = "";
  const made = await vaultOp({ t: "add", name, weightMg: 0 });
  const kit: OpResult = made.ok && made.item ? await vaultOp({ t: "kit", id: made.item.id, parts, ownWeightMg: 0 }) : { ok: false };
  kitSaving.delete(DRAFT_ID);
  if (!kit.ok || !kit.item) {
    loadError.value = made.reason === "duplicate" ? "You already have something called that in My Gear." : "Couldn’t make that kit. Check your connection and try again.";
    // a piece made without its kit is real gear now: show it
    if (made.ok) void loadVault();
    return;
  }
  draftKit.value = null;
  putKit(kit.item);
}
// "New kit", at the foot of the Kits tab the way "Add folder" ends a list (AddFolder):
// the name opens a section there, on its "Add an item" line, and nothing is saved until
// the first item goes in — then the piece and the kit are made together (setKit).
// Writing the piece at once left a 0 g "Cook kit" in your gear whenever you changed
// your mind (Escape, a reload).
const draftKit = ref<VaultEntry | null>(null);
const DRAFT_ID = -1;
function startDraftKit(name: string) {
  draftKit.value = { id: DRAFT_ID, normKey: "", name, weightMg: 0, timesSeen: 0, lastUsedAt: "", createdAt: "" };
}
// the Kits tab's sections: the kits, then an unsaved new kit where "New kit" was
const kitSections = computed(() => (draftKit.value ? [...filtered.value, draftKit.value] : filtered.value));
// What the gear on screen cost. Follows `filtered` like the weight beside it — both
// figures describe what you are looking at, so a search for "jacket" answers what the
// jackets cost without a second control.
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

// The line under a search that matched nothing, naming what was searched.
const noneLine = computed(() => (query.value.trim() ? `Nothing here matches “${query.value.trim()}”.` : ""));

// ---- adding gear by hand -------------------------------------------------
// The half capture can't do. Gear arrives here on its own from every list you build,
// which covers the common case beautifully and answers nothing at all for the pack
// you bought yesterday and haven't packed yet.
//
// "Add gear" opens the edit dialog blank (VaultItemModal's `adding`), with a catalog
// search over the form: one form for adding and correcting, so a piece goes in with
// everything it can hold. It replaced an inline name-and-weight row, which hid the
// rest and read as broken. A piece lands under its kind by itself.
const adding = ref(false);
const BLANK_PIECE: VaultEntry = { id: 0, normKey: "", name: "", weightMg: 0, timesSeen: 0, lastUsedAt: "", createdAt: "" };
function openAdd() {
  query.value = "";
  adding.value = true;
  editing.value = { ...BLANK_PIECE };
}
function closeDialog() {
  editing.value = null;
  adding.value = false;
}
// in place, first in its kind (the page orders by last use), rather than a reload
function onItemAdded(item: VaultEntry) {
  closeDialog();
  items.value = [item, ...items.value];
  offerAdded(item);
}

// A piece sorts itself into its kind, often far down the page or into a collapsed
// section, so the add row reset under a piece that had silently gone somewhere else
// (the 2026-11-08 UX audit's first finding). Say where, with the way back. Undo is a
// put-away, the only removal there is (a tombstone; see remove.post.ts).
function offerAdded(item: VaultEntry) {
  const kind = vaultFamilyOf(item);
  offerUndo({
    verb: "Added",
    label: itemDisplayName(item.brand, item.name, item.variant),
    tail: ` to ${gearFamilyLabel(kind)}`,
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
  const res = await vaultOp({ t: "edit", id: entry.id, patch });
  if (res.ok && res.item) return put(res.item);
  put(before);
  loadError.value = `Couldn’t save that ${what}. Check your connection and try again.`;
}
// a kit's name, typed on its open row (the only thing about a kit a dialog held)
function renameKit(entry: VaultEntry, name: string) {
  if (entry.id === DRAFT_ID && draftKit.value) return void (draftKit.value = { ...draftKit.value, name });
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
    tail: ` to ${gearFamilyLabel(to)}`,
    restore: () => patchEntry({ ...entry, icon: glyph ?? undefined }, { icon: was }, "icon"),
  });
}
// Patch the one row in place rather than re-reading the vault: the endpoint returns
// the row as it now stands, and a full reload would re-sort the page under a dialog
// that just closed (a rename can move a row under A–Z).
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
// most recent list on this device (whatever you already work in), or from a choice
// made on this page before its unit picker went (it sat on the weight total, which
// went for answering no question). Each row picks its own unit as well.
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

// ---- remove + undo -------------------------------------------------------
// No confirm dialog: removing gear is small, reversible, and something you'd do
// several times in a row while tidying. An immediate removal with an undo beats a
// modal per row. (Deleting a whole LIST keeps its dialog — that one isn't
// reversible.)
const removing = ref<number | null>(null);
// The undo bar: the editor's own (UndoBar, on useUndo's timer), holding what happened
// and how to take it back. Every change here that takes something away offers it: a
// piece removed, an item taken out of a kit (Ryan: "we should audit for toasts that
// don't allow undo"); and an add offers to take the piece back off.
const { pending: undoable, offer: offerUndo, hold: holdUndo, release: releaseUndo, clear: clearUndo, take: undo } = useUndo();
onBeforeUnmount(clearUndo);

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

// Sign in without losing the vault behind it — the account opens over this page.
const { open: openAccount } = useAccountModal();
// The page's own order. A–Z / Heaviest / Lightest wear sort glyphs (A–Z the ordered
// list with A over Z); By kind takes a grid mark because it is a LAYOUT, not a sort
// key, and shouldn't borrow one.
// In the order they're reached for: the layout, then weight (the reason anyone sorts
// gear in a pack-weight app: what to cut), then use, and A–Z last, since the search
// already finds a thing by its name.
const VIEW_OPTIONS = [
  { key: "kinds", label: "By kind", icon: Shapes01Icon },
  { key: "heaviest", label: "Heaviest", icon: SortingNineOneIcon },
  { key: "lightest", label: "Lightest", icon: SortingOneNineIcon },
  { key: "recent", label: "Recently used", icon: Clock01Icon },
  { key: "most", label: "Most used", icon: StarIcon },
  { key: "az", label: "A–Z", icon: ListOrderedAzIcon },
];
// The trigger wears its current option's mark and name in place of a "View" word: the
// value already says which question it answers, and the mark is the one the open menu
// puts beside the same row.
const viewOption = computed(() => VIEW_OPTIONS.find((o) => o.key === view.value) ?? VIEW_OPTIONS[0]!);

// ---- taking it with you --------------------------------------------------
// My Gear is the one thing an account holds rather than a link, which makes it the
// one thing you can't already take with you by copying a URL — and until this, the
// only account-level data operation was delete.
//
// ALL of it, not what a search has narrowed to: that is how you're looking at your
// gear, and a file called my-gear that quietly held only the jackets would be a worse
// answer than no file. `items` is the live gear — what
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
           belong beside the search and the order.
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
          <!-- the tabs, and opposite them on Gear the way to add a piece: the field it
               opens sits at the head of the list. A kit is made at the foot of the
               Kits tab instead, as a list's folder is ("New kit", below). -->
          <div class="vault__tabbar">
            <ModeBar :modes="TABS" :current="tab" label="My Gear view" @pick="pickTab" />
            <button v-if="tab === 'gear'" type="button" class="btn btn--quiet ink-quiet vault__tabadd" @click="query = ''; openAdd()">
              <HugeiconsIcon :icon="PlusSignIcon" :size="16" :stroke-width="2" aria-hidden="true" />
              Add gear
            </button>
          </div>
          <!-- Nothing to search or order until there IS gear — controls over
               "Nothing here yet" are furniture for a room with no floor. -->
          <div v-if="items.length" class="vault__bar">
            <!-- the field and its own clear — SearchField, the same control the gear
                 pane draws; only the sizing is this page's -->
            <SearchField
              v-model="query"
              class="vault__searchwrap"
              :placeholder="tab === 'kits' ? 'Search my kits…' : 'Search my gear…'"
              :label="tab === 'kits' ? 'Search my kits' : 'Search my gear'"
            />

            <!-- The question a gear of two hundred rows raises, what order, as the
                 app's own picker. It rides the trailing edge, over the rows' own
                 trailing controls. -->
            <!-- Gear only: kits are a handful of sections, not a list to order or sort -->
            <OptionMenu
              v-if="tab === 'gear'"
              class="vault__view"
              :options="VIEW_OPTIONS"
              :current="view"
              label="How to order My Gear"
              @pick="(k) => (view = k as VaultView)"
            >
              <template #trigger="{ open }">
                <HugeiconsIcon :icon="viewOption.icon" class="vault__viewmark" :size="16" :stroke-width="2" aria-hidden="true" />
                {{ viewOption.label }}
                <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2.25" aria-hidden="true" />
              </template>
            </OptionMenu>
          </div>

          <p v-if="loadError" class="t-sm vault__error">{{ loadError }}</p>

          <!-- only while there is nothing to show yet. An add reloads the gear, and
               blanking a page you are working on for the length of a round trip
               reads as the page losing your gear. -->
          <p v-if="loading && !items.length" class="t-muted vault__empty">Loading your gear…</p>

          <template v-else-if="items.length">
            <p class="t-sm t-muted vault__count">
              <template v-if="narrowed">{{ formatCount(filtered.length) }} of {{ formatCount(onTab.length) }}</template>
              <template v-else>{{ formatCount(onTab.length) }}</template>
              {{ pluralNoun(onTab.length, countNoun) }}
              <!-- No weight total: it added up everything you own, which nobody carries
                   at once, so it answered no question (it went 2026-11-08, with the unit
                   picker it doubled as; each row has its own, and the page opens in your
                   last choice or your most recent list's unit). What it cost stays: that
                   one is a real question about a closet, and the reason a price is worth
                   recording at all. -->
              <template v-if="totalPrice">
                · <span class="t-num" :title="priceTitle">{{ formatPrice(totalPrice.cents, totalPrice.currency) }}</span>
              </template>
            </p>

            <!-- KITS: each kit a section, the way a kind is on the Gear tab — its name for
                 the heading, its items as rows of gear (VaultKitSection) -->
            <template v-if="tab === 'kits'">
              <VaultKitSection
                v-for="kit in kitSections"
                :key="kit.id"
                :kit="kit"
                :gear-by-id="gearById"
                :unit="unit"
                :busy="kitSaving.has(kit.id)"
                @kit="(parts: { id: number; qty: number }[], own: number) => setKit(kit, parts, own)"
                @rename="(n: string) => renameKit(kit, n)"
                @remove="remove(kit)"
                @cancel="draftKit = null"
                @edit="openEdit"
                @icon="setEntryIcon"
                @unit="setEntryUnit"
              />
            </template>

            <!-- GEAR: by kind, in the section a kit uses (VaultSection), with a kind's
                 name for a heading: nothing to rename, delete or drag, because nobody
                 filed anything. A chosen order or a search is the same loop with one
                 section and no heading: one list, one order, since a kind owning an order
                 of its own is what would make "heaviest" mean nothing. -->
            <template v-else>
              <VaultSection
                v-for="section in sections"
                :key="section.key"
                v-slot="{ overlay }"
                :label="section.label"
                :collapse-key="section.key"
              >
                <VaultGearRow
                  v-for="entry in section.entries"
                  :key="entry.id"
                  :entry="entry"
                  :unit="unit"
                  :busy="removing === entry.id"
                  :in-kits="inKitsById.get(entry.id)"
                  @edit="openEdit(entry)"
                  @remove="remove(entry)"
                  @unit="(u: Unit) => setEntryUnit(entry, u)"
                  @icon="(g: GearGlyph | null) => setEntryIcon(entry, g)"
                  @overlay-toggle="overlay"
                />
              </VaultSection>
            </template>

            <!-- a search that matched nothing, said with the words searched -->
            <p v-if="!filtered.length && noneLine" class="t-muted vault__none">{{ noneLine }}</p>
            <p v-else-if="tab === 'kits' && !onTab.length && !draftKit" class="t-muted vault__none">
              No kits yet. Make one with New kit.
            </p>
            <!-- a kit is this page's folder, made the way a list makes one: the quiet
                 label at the foot becomes the name field, and the kit opens where it was -->
            <AddFolder v-if="tab === 'kits' && !query && !draftKit" class="vault__addkit" label="New kit" placeholder="Kit name" @add="startDraftKit" />

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
            <div class="vault__emptyacts">
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
         who came to look rather than to correct or add — the same idiom the editor
         uses for its own modals. -->
    <LazyVaultItemModal
      v-if="editorEverOpened"
      :entry="editing"
      :adding="adding"
      :unit="unit"
      :default-currency="vaultCurrency"
      :known="knownVocab"
      @close="closeDialog"
      @saved="onItemSaved"
      @added="onItemAdded"
    >
      <!-- The add dialog's catalog search, the list editor's own name field (ItemInput),
           catalog-only and pick-only. The PAGE renders it and the dialog places it, so
           the field stays in /gear's own chunk graph, as the inline add row kept it:
           rendered inside the lazy dialog it left that graph, and the bundler split the
           editor's shared chunk three ways around it, 0.7 KB more on the editor's
           first load for the same code. -->
      <template #search="{ pick, typed, submit }">
        <ItemInput
          class="vault__catalog"
          :unit="unit"
          placeholder="Search the catalog"
          sources="catalog"
          pick-only
          well
          autofocus
          @draft="typed"
          @commit="pick"
          @submit="submit"
        />
      </template>
    </LazyVaultItemModal>

    <!-- Same lazy idiom: nobody who never imports downloads the parser. -->
    <LazyVaultImportModal
      v-if="importEverOpened"
      :open="importOpen"
      @close="importOpen = false"
      @imported="loadVault"
    />

    <!-- Removal lands as the editor's own undo bar: same component, same timer, same
         place on screen. -->
    <Transition name="toast">
      <UndoBar
        v-if="undoable"
        :undo="undoable"
        @take="undo()"
        @hold="(held: boolean) => (held ? holdUndo() : releaseUndo())"
      />
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
  /* wraps at EVERY width, not only below $bp-stack: a narrowed desktop window drops
     the picker to its own line rather than crush the field beside it */
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
/* mark + value + chevron, on the trailing edge over the rows' own trailing controls;
   the value says which question it answers, so no "View" word */
.vault__view {
  margin-left: auto;
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
/* the mark and its turn are the shared .chev (atoms/controls.scss); focus lights it,
   and so does the pointer (below) */
.vault__view:focus-within .chev {
  color: var(--ink);
}
/* Pointer-gated, like every hover on this page that paints, ink included: on touch
   a tap leaves :hover latched on the picker after its menu has closed, a lit control
   nothing is pointing at. Focus (the rules above) is what touch and keys get. */
@media (hover: hover) and (pointer: fine) {
  .vault__view:hover,
  .vault__view:hover .chev {
    color: var(--ink);
  }
}
/* a clear break before the first heading, on both tabs: the count closes the controls
   above it, and the gear starts below */
.vault__count {
  margin-bottom: var(--space-5);
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

/* the add dialog's catalog search (rendered here, placed by VaultItemModal's #search),
   a step above the form it fills */
.vault__catalog {
  margin-bottom: var(--space-4);
}
/* "New kit" a section's gap below the last kit, as the kits stand from each other */
.vault__addkit {
  margin-top: var(--space-6);
}
/* The list's mode bar, in the list's exact spot: the editor's body pads its top by
   --space-1 (.editor__body) where a page pads by --space-5 (.page), so this page takes
   the editor's padding whenever the tabs are up (signed in) and its first tab lands
   where the list's does, 8px under the bar. Keyed on the tabs being there, not on a
   class, because they render client-side only. */
.vault__page:has(.vault__tabbar) {
  padding-top: var(--space-1);
}
.vault__tabbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.vault__tabadd {
  flex: none;
  gap: var(--space-1);
}

@media (max-width: $bp-stack) {
  /* the search drops its cap, so it ends on the picker's edge rather than short of it */
  .vault__searchwrap {
    max-width: none;
  }
  /* The picker keeps its word ("By kind") beside the search: it hid it when a second
     picker shared the line, and one fits. */
  .vault__bar {
    flex-wrap: nowrap;
  }
  /* the row's own phone stack (name on its own line, the rest beneath) is
     VaultGearRow's */
}
</style>
