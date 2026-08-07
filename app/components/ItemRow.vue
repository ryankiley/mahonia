<script lang="ts">
import type { Classification, Item as ItemT, Unit } from "~~/shared/types";
import { UNITS } from "~~/shared/types";

// static per-component tables — module scope so a large list doesn't rebuild
// them in every row instance
const STEP_BY_UNIT: Record<Unit, number> = { g: 1, kg: 0.01, oz: 0.1, lb: 0.1 };
// one stable empty array for every leaf row, so `children` never mints a fresh
// identity per row per render
const NO_ITEMS: ItemT[] = [];
// Per-item nest-collapse, read through a module-level cache rather than straight off
// localStorage. Storage is synchronous, and every row reads its own key on mount — so a
// mode switch, which remounts the whole list, was paying one blocking read per row for an
// answer that only this app ever writes. Cached on first read and kept in step by
// setNestCollapsed, so the value is still exactly what's on disk.
const nestCollapsedCache = new Map<string, boolean>();
function nestCollapsedFor(key: string): boolean {
  let v = nestCollapsedCache.get(key);
  if (v === undefined) {
    try {
      v = localStorage.getItem(key) === "1";
    } catch {
      v = false; // private mode / no storage — default expanded
    }
    nestCollapsedCache.set(key, v);
  }
  return v;
}
function setNestCollapsed(key: string, on: boolean) {
  nestCollapsedCache.set(key, on);
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}
// A cache that never re-read would out-live the truth: `storage` fires in the OTHER
// tabs, so the same list open twice would keep showing its own stale collapse state on
// the next remount. Dropping the entry sends the next read back to disk — which is
// exactly what happened before the cache existed.
if (import.meta.client) {
  window.addEventListener("storage", (e) => {
    if (e.key?.startsWith("gear.nest.")) nestCollapsedCache.delete(e.key);
    else if (e.key === null) nestCollapsedCache.clear(); // storage.clear() in another tab
  });
}
// offered "N worn" split counts stop here (the stored value is always shown even
// beyond the cap, so clamps/imports can't strand invisible state)
const MAX_SPLIT_OPTS = 5;
// the four units as OptionMenu rows — the abbreviation is the label, matching the
// figure it sits beside (see TotalsBar, which builds the same list)
const UNIT_OPTIONS = UNITS.map((u) => ({ key: u, label: u }));
</script>

<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { CalculateIcon, Cancel01Icon, CheckIcon, CheckmarkSquare02Icon, ChevronDownIcon, CircleEllipsisIcon, CookieIcon, Delete02Icon, GripVerticalIcon, ListIndentDecreaseIcon, ListIndentIncreaseIcon, ListPlusIcon, NoteAddIcon, NoteRemoveIcon, SafeBoxIcon, ShirtIcon, SquareIcon } from "@hugeicons/core-free-icons";
import type { Item, ListSnapshot } from "~~/shared/types";
import type { ItemPatch } from "~~/shared/ops";
import type { NameCommit } from "~/composables/useCatalogSearch";
import { bySortOrder, effectiveClassification, entryUnitFromInput, formatKcal, formatWeight, fromMg, groupLineMg, itemDisplayName, parseWeightInput, rowDisplayMg, siblingItems, splitWornQty } from "~~/shared/weights";
import { isWaterName, itemQtyLabel, waterLiters, waterMgFromMl } from "~~/shared/water";
// the same worthiness + identity rules the capture path runs, so "already banked"
// below can only ever claim what capture would actually take (statically imported
// like useGearList's own vaultNormKey — this module is in the editor graph already)
import { isVaultWorthy, vaultNormKey } from "~~/shared/vault";

// The editor's row — editable by default, a checklist row in packing mode. A nested item
// renders the SAME row with `nested` set (indented, one level only). The share views
// (/s + /l) render ReadonlyItemRow instead, so this component (and the editor graph it
// pulls in) never ships to a read-only page.
const props = withDefaults(
  defineProps<{
    list: ListSnapshot;
    item: Item;
    // children grouped by parent id — ONE groupItemsByParent pass per snapshot at
    // the view root (GearEditor), threaded to every row, so each row doesn't
    // re-scan the whole item array for its children on every render
    childrenByParent: Map<string, Item[]>;
    // the row rendered directly ABOVE this one in the parent's DISPLAY order
    // (null = first row) — drives the indent affordance + its nest target, so a
    // name/weight-sorted folder indents under the row you actually see above
    prevId?: string | null;
    // NO `packed` prop — deliberately. Which face of the row shows (checklist vs
    // editable) is decided by CSS off the editor body's data-mode (atoms/item.scss);
    // as a prop, every mode switch re-rendered every row on the page. Handlers that
    // need the mode read useEditorMode at CALL time, which registers no reactive
    // dependency — see that composable's header.
    nested?: boolean;
  }>(),
  { prevId: null, nested: false },
);
// forwarded up to FolderSection so it can lift its collapse clip while this row has a
// floating overlay open — the name autocomplete, or the mobile ⋯ menu (otherwise an
// overlay at the folder's bottom is cropped)
const emit = defineEmits<{ overlayToggle: [boolean]; toast: [string] }>();
const c = useGearList();
// two jobs for the vault button: telling "your vault is unreachable" from "you
// don't have one" when banking a row fails (the button is offered signed out too,
// since signing in is a reasonable answer to pressing it), and gating vaultCovered
// below — signed out, nothing reaches a vault automatically, so no row may claim
// it's already there
const { hasVault } = useVaultAccess();

// The two mount latches (each row face mounts the first time its mode is entered and
// then stays, CSS-hidden elsewhere) and the mode itself, for event handlers only —
// neither `mode` nor anything else here changes per switch in a way this row renders.
const { mode: editorMode, everEdit, everPacked } = useEditorMode();

// ---- nesting: children render as the SAME row, indented under this one ----
// A row with children is a "group": its weight column shows the group total (own +
// children, read-only, like a folder subtotal); the children carry the real editable
// weights. Nesting is one level, so a nested row never renders its own children.
const children = computed(() =>
  props.nested ? NO_ITEMS : (props.childrenByParent.get(props.item.id) ?? NO_ITEMS),
);
const isParent = computed(() => children.value.length > 0);
// collapse a nested group — hide/show its children, persisted per item id (pure UI
// state, never sent to the server), mirroring the folder collapse. Only meaningful on
// a parent row; packing mode always shows children (you're checking them off).
const NEST_KEY = `gear.nest.${props.item.id}`;
const nestCollapsed = ref(false);
// Still adopted on MOUNT rather than at setup, so the first paint is unchanged — this
// only swaps where the value comes from (see nestCollapsedFor above).
onMounted(() => {
  nestCollapsed.value = nestCollapsedFor(NEST_KEY);
});
function toggleNest() {
  nestCollapsed.value = !nestCollapsed.value;
  setNestCollapsed(NEST_KEY, nestCollapsed.value);
}
// the group total shown on a parent's read-only weight column (bare number, list
// unit) — `children` holds exactly this row's children, so the sum is O(children)
const groupWeight = computed(() =>
  formatWeight(groupLineMg(props.item, children.value), props.list.displayUnit, { withUnit: false }),
);
// the packing row's weight — same rule as the read views (ReadonlyItemRow): a
// group shows its total (own + children), a leaf its own line
const rowWeightMg = computed(() => rowDisplayMg(props.item, children.value));
// Indent (nest under the row above): only a top-level, childless row with a row
// above it in DISPLAY order can (keeps nesting one level deep; prevId comes from
// the parent's v-for, so a sorted folder nests under the row you see, not the
// sortOrder-previous one). Outdent is offered to any child.
const canIndent = computed(() => !props.nested && !isParent.value && props.prevId != null);

// drag-to-reorder (editable rows only)
const dnd = useItemDnd();
const isDragging = computed(() => dnd.dragId.value === props.item.id);
// the group's collapse clip (overflow:hidden on .nest-block, needed for the 1fr↔0fr
// slide) would crop a child's autocomplete dropdown or a lifted drag row. Lift it
// while a child overlay is open or any drag is in flight — mirrors the folder's
// overlay/dragpass lifts. Counts CHILD overlays only (the parent's own dropdown opens
// above the block); still bubbles each up so the folder lifts its clip too. Never
// lifts when collapsed (hidden children can't open an overlay or be dragged).
const nestOverlayCount = ref(0);
function onChildOverlay(open: boolean) {
  nestOverlayCount.value = Math.max(0, nestOverlayCount.value + (open ? 1 : -1));
  emit("overlayToggle", open);
}
const nestLifted = computed(
  () => !nestCollapsed.value && (nestOverlayCount.value > 0 || dnd.dragId.value != null),
);
const isDropBefore = computed(
  () =>
    dnd.dragId.value != null &&
    dnd.dragId.value !== props.item.id &&
    dnd.drop.value?.beforeId === props.item.id,
);
// end-of-group indicator: a nested sibling dragged below its last sibling appends as
// this row's LAST CHILD (useItemDnd encodes it as {parentId, beforeId: null}) — mark
// that landing spot at the group's tail. The folder-tail line must not light up for
// it; see FolderSection's isAppendTarget parentId guard.
const isNestAppendTarget = computed(
  () =>
    dnd.dragId.value != null &&
    dnd.drop.value?.parentId === props.item.id &&
    dnd.drop.value?.beforeId == null,
);
// "will nest under this row" highlight: when a drag targets this row as the new parent
// (drag-right past the threshold, useItemDnd), tint the row so the intent reads — the
// one feedback for nesting under a row that has NO children yet (no group tail to show)
const isNestParent = computed(
  () =>
    dnd.dragId.value != null &&
    dnd.dragId.value !== props.item.id &&
    dnd.drop.value?.parentId === props.item.id,
);
// keyboard path for the reorder grip (its label promises reordering, but a drag
// needs a pointer): ArrowUp/Down move the row one slot among its sortOrder-sorted
// siblings, through the same moveItem commit a drop uses — persistence and
// reindexing come for free
function onGripKey(e: KeyboardEvent) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  const parentId = props.item.parentId ?? null;
  // a top-level row in a non-manual folder is displayed in the sort's order, NOT
  // sortOrder — reordering it would rewrite the manual order invisibly (the drag
  // path bails the same way, useItemDnd). Nested children always render in
  // sortOrder, so their keyboard reorder stays meaningful.
  if (parentId == null) {
    const sortBy = props.list.folders.find((f) => f.id === props.item.folderId)?.sortBy ?? "manual";
    if (sortBy !== "manual") return;
  }
  const sibs = siblingItems(props.list.items, props.item.folderId, parentId).sort(bySortOrder);
  const i = sibs.findIndex((s) => s.id === props.item.id);
  if (i < 0) return;
  if (e.key === "ArrowUp") {
    const above = sibs[i - 1];
    if (above) c.moveItem(props.item.id, props.item.folderId, above.id, parentId);
  } else if (sibs[i + 1]) {
    // one slot down = insert before the row after next (none = append)
    c.moveItem(props.item.id, props.item.folderId, sibs[i + 2]?.id ?? null, parentId);
  }
  // the reorder re-inserts this row's DOM node, blurring the grip — re-focus it so
  // repeat presses work (the row's component is keyed by id, so the ref persists)
  const grip = e.currentTarget as HTMLElement;
  nextTick(() => grip.focus());
}

// a just-added "Add an item" row autofocuses its name; any row whose fields are
// all still empty removes itself when focus leaves it — an abandoned blank, or
// one you clicked into and out of (no empty-row litter). discardEmpty verifies
// the emptiness against the snapshot, so a row with content is never touched.
const wrapRef = useTemplateRef<HTMLElement>("wrapRef");
const isPendingBlank = computed(() => c.pendingBlankId.value === props.item.id);
function onRowBlur(e: FocusEvent) {
  // packing mode shares the row wrapper but has no editable fields — a checkbox
  // blur must never discard a (still-unnamed) row. Read at call time: a handler
  // read of the mode ref registers no reactive dependency (see useEditorMode).
  if (editorMode.value === "pack") return;
  const next = e.relatedTarget as Node | null;
  if (wrapRef.value?.contains(next)) return; // focus moved within the row — keep
  // focus left the window entirely (alt-tab / app switch) rather than moving
  // elsewhere in the app — keep the row so they can come back and finish it
  if (!next && typeof document !== "undefined" && !document.hasFocus()) return;
  nameEditing.value = false; // done with this row — an untouched common-name field folds away
  c.discardEmpty(props.item.id);
}

// edit field: the bare number in the list unit (formatWeight is strict, so the shown
// number stays in that unit — the unit label + parser agree, no rescale). A weight too
// small to show in the chosen unit renders as "<0.01" (never a wrong "0"); tapping in
// selects that label so a real number replaces it (onWeightFocus), and onWeight refuses
// to commit a "<…" label back as a value.
// The unit THIS row reads in: whatever was typed, else the list's. One computed so
// the field, its unit label, the arrow-key step and the packed row's static weight
// can't drift apart — they must all agree, or the number means something different
// from the label beside it.
//
// A GROUP row is excluded on purpose: its figure is the sum of children that may
// each have been typed in a different unit, so there's no entry unit to honour and
// the list's own is the only honest choice.
const rowUnit = computed(() =>
  isParent.value ? props.list.displayUnit : (props.item.entryUnit ?? props.list.displayUnit),
);

const weightDisplay = computed(() =>
  props.item.unitWeightMg > 0
    ? formatWeight(props.item.unitWeightMg, rowUnit.value, { withUnit: false })
    : "",
);

const effClass = computed(() =>
  effectiveClassification(props.item, props.list.folders),
);

// the editable name field shows the full flat "Brand Model Variant" so a rename
// edits the whole thing; the static (read-only/packed) views render it structured
// with the variant dimmed via <ItemName>.
const editableName = computed(() =>
  itemDisplayName(props.item.brand, props.item.name, props.item.variant),
);

// water rows: the qty field becomes a LITRES field (water is 1 L = 1 kg), driving
// the weight; the weight field itself is read-only so the two can't desync.
// (isWaterName / waterLiters / itemQtyLabel live in shared/water, shared with
// ReadonlyItemRow so the two views can't drift.)
const isWater = computed(() => isWaterName(props.item.name));
const litersDisplay = computed(() => waterLiters(props.item.unitWeightMg));
function onWaterLiters(e: Event) {
  const el = e.target as HTMLInputElement;
  const liters = Math.max(0, Number(el.value) || 0);
  c.updateItem(props.item.id, {
    // one source of truth for volume→weight (shared/water), matching ItemInput's
    // water suggestion — the row used to round to whole mL first and could drift
    unitWeightMg: waterMgFromMl(liters * 1000),
    weightOverridden: true,
  });
  el.value = litersDisplay.value; // resync (in-place op mutation makes it fresh)
}

function onWeight(e: Event) {
  if (isWater.value || isParent.value) return; // water + group weights are derived, not typed
  const el = e.target as HTMLInputElement;
  // "<0.01"-style text is the DISPLAY for a real weight too small to render in the
  // chosen unit — a label, not an entry. Never parse it back (that would overwrite the
  // true sub-precision weight with the rounded-up label). A genuine edit replaces it.
  if (!el.value.trim().startsWith("<")) c.setItemWeight(props.item.id, el.value);
  el.value = weightDisplay.value; // resync to canonical (handles unparseable / no-op edits)
}
// tapping a "<0.01"-style weight selects the label so the first keystroke replaces it
// with a real number instead of appending to it ("<0.013" → nonsense)
function onWeightFocus(e: Event) {
  const el = e.target as HTMLInputElement;
  if (el.value.trim().startsWith("<")) el.select();
}
// Changing the unit RE-EXPRESSES the same weight, it never converts the number: the
// row holds canonical milligrams, so picking oz just asks for those milligrams in
// ounces. (Typing "3.8 oz" sets the same field — see setItemWeight.)
function onRowUnit(u: Unit) {
  c.updateItem(props.item.id, { entryUnit: u });
}
function onQty(e: Event) {
  const el = e.target as HTMLInputElement;
  const q = Math.max(1, Number(el.value) || 1);
  c.updateItem(props.item.id, { qty: q });
  el.value = String(q); // resync even when the clamp is a no-op (e.g. 0 / letters)
}
// The two sub-fields resync for the same reason the numbers above do — the reducer
// tidies the text it stores (shared/tidyText), and these are uncontrolled inputs, so
// when the tidied result matches what's already in state (retyping "Ryan's" over a
// stored "Ryan’s") no reactive change happens and the field would keep the typed form.
function onCommonName(e: Event) {
  const el = e.target as HTMLInputElement;
  c.updateItem(props.item.id, { commonName: el.value, commonNameOverridden: true });
  el.value = props.item.commonName ?? "";
}
function onNote(e: Event) {
  const el = e.target as HTMLInputElement;
  c.updateItem(props.item.id, { description: el.value });
  el.value = props.item.description ?? "";
}
// arrow keys nudge the weight by a unit-appropriate step (Shift = ×10), so you can
// tap into the field and increment/decrement without retyping
function onWeightStep(e: KeyboardEvent, dir: 1 | -1) {
  if (isWater.value || isParent.value) return; // water + group weights are derived, not typed
  // step in the unit the row READS in, not the list's — arrowing on a row showing
  // "3.8 oz" must move it by an ounce step, or the number jumps unpredictably
  const unit = rowUnit.value;
  const step = (STEP_BY_UNIT[unit] ?? 1) * (e.shiftKey ? 10 : 1);
  const current = fromMg(props.item.unitWeightMg, unit);
  const next = Math.max(0, Number((current + dir * step).toFixed(unit === "g" ? 0 : 2)));
  c.setItemWeight(props.item.id, String(next));
  // in-place op-reducer mutation makes weightDisplay fresh synchronously
  (e.target as HTMLInputElement).value = weightDisplay.value;
}

// renaming in place via the same autocomplete: a catalog pick re-links + fills the
// weight; a free-text rename just updates the name (or its trailing weight).
function onNameCommit(p: NameCommit) {
  const patch: ItemPatch = { name: p.name };
  if (p.fromVault) {
    // Pulled from your own vault. It may carry a catalog link (it does when the
    // gear first arrived as a catalog pick), and that link is kept for provenance
    // — but every VALUE here is yours, not the catalog's, so each is marked
    // overridden. Without that, live-resolve would quietly rewrite your measured
    // weight and your chosen name back to the catalog's on the next snapshot,
    // which would make the vault pointless for exactly the gear it matters most
    // for: the item whose spec weight is wrong.
    patch.catalogItemId = p.catalogItemId ?? null;
    patch.brand = p.brand ?? "";
    patch.variant = p.variant ?? "";
    patch.nameOverridden = true;
    if (p.weightMg != null && p.weightMg > 0) {
      patch.unitWeightMg = p.weightMg;
      patch.weightOverridden = true;
    }
    // catalogWeightMgAtLink is deliberately NOT set: it's the baseline for the
    // "the catalog's weight changed" nudge, and your own weight is not that
    // baseline — stamping it here would compare the catalog against you. The row
    // ends up with no baseline at all, not the PREVIOUS product's: the reducer
    // drops a baseline whose link has moved (shared/ops, updateItem).
    if (!props.item.commonNameOverridden && p.commonName) {
      patch.commonName = p.commonName;
      patch.commonNameOverridden = true;
    }
    if (p.priceCents != null) {
      patch.priceCents = p.priceCents;
      patch.currency = p.currency;
    }
    // the vault's remembered calories land like its weight does — this is YOUR
    // number for the food; absent leaves whatever the row already says
    if (p.kcal != null) patch.kcal = p.kcal;
  } else if (p.catalogItemId != null) {
    // a catalog pick: store brand/model/variant structured, link, and let
    // live-resolve keep the name fresh ("" clears any prior brand/variant)
    patch.catalogItemId = p.catalogItemId;
    patch.unitWeightMg = p.weightMg;
    patch.catalogWeightMgAtLink = p.weightMg;
    patch.weightOverridden = false;
    patch.brand = p.brand ?? "";
    patch.variant = p.variant ?? "";
    patch.nameOverridden = false;
    // pre-fill the catalog's default common name — unless the user already typed
    // their own (a rename they want kept), mirroring the nameOverridden gate
    if (!props.item.commonNameOverridden) {
      patch.commonName = p.commonName ?? "";
      patch.commonNameOverridden = false;
    }
  } else {
    // free text / water / trailing weight → a user-owned custom name: drop the
    // catalog-derived brand/variant AND the catalog link itself — renaming to a
    // different product (or a like-item "upgrade") must not stay linked to the
    // old row, or its weight-drift nudge would fire from the wrong product
    patch.brand = "";
    patch.variant = "";
    patch.catalogItemId = null;
    patch.nameOverridden = true;
    // the gear type that arrived WITH the catalog row is catalog-derived too, so it
    // goes the same way as brand/variant — otherwise "Zpacks Duplex" renamed to "my
    // old tarp" keeps reading "Tent" forever, and with the link now gone
    // hydrateCatalogNames can never correct it. A gear type the user typed
    // themselves (commonNameOverridden) is theirs and survives the rename.
    if (!props.item.commonNameOverridden) patch.commonName = "";
    if (p.weightMg != null) {
      // a resolved weight with no catalog link (e.g. a water volume → fixed grams)
      patch.unitWeightMg = p.weightMg;
      patch.weightOverridden = true;
    } else if (p.weight != null) {
      // parse against the unit the row already reads in (rowUnit), same rule as
      // setItemWeight — a trailing "4.2" on an oz row is 4.2 ounces
      const mg = parseWeightInput(p.weight, rowUnit.value);
      if (mg != null) {
        patch.unitWeightMg = mg;
        patch.weightOverridden = true;
        const named = entryUnitFromInput(p.weight);
        if (named) patch.entryUnit = named;
      }
    }
  }
  // water arrives as a consumable; base is stored as null (the folder default)
  if (p.classification !== undefined) patch.classification = p.classification === "base" ? null : p.classification;
  c.updateItem(props.item.id, patch);
}

// a base row with multiples can split its count into worn + base (e.g. 3 pairs
// of socks, 1 worn) — see the worn popover below, which is where the count lives
const activeSplit = computed(() => splitWornQty(props.item, effClass.value)); // 0 = no split

// ---- classification as two toggles ----
// Replaces the old three-option <select>. The data model was already shaped for
// this: `classification` is ONE field with base stored as null, so "worn off and
// consumable off" IS base — the pair of toggles is a direct rendering of the type,
// not a second representation of it that could disagree.
//
// Mutually exclusive by construction: turning one on turns the other off, because
// the field can only hold one value. That is also why they are two buttons and not
// a checkbox pair — checkboxes would imply both could be true.
const isWorn = computed(() => effClass.value === "worn" || activeSplit.value > 0);
const isConsumable = computed(() => effClass.value === "consumable");

// base is stored as null — the folder default — EXCEPT where the folder itself
// defaults to something else, in which case base has to be pinned explicitly or
// clearing a class would silently re-inherit worn/consumable
function baseValue(): Classification | null {
  const folderDefault = effectiveClassification(
    { classification: null, folderId: props.item.folderId },
    props.list.folders,
  );
  return folderDefault === "base" ? null : "base";
}

function setClass(next: "worn" | "consumable", on: boolean) {
  c.updateItem(props.item.id, {
    classification: on ? next : baseValue(),
    // a whole-row class makes the split meaningless (the reducer clears it too);
    // turning worn OFF drops it as well, since the split only describes a base line
    wornQty: 0,
  });
}

// the split: N of qty are worn, the remainder stays base. Only offered on a row
// with multiples — one of one is just "worn".
//
// Picking the ACTIVE count again clears it, the same way pressing a switch that is
// already on turns it off. Without that the split is a one-way door: worn is off
// during a split (it is a base line with a worn portion), so the switch above can't
// undo it and the only way back would be to change the quantity.
function setSplit(n: number) {
  c.updateItem(props.item.id, {
    wornQty: activeSplit.value === n ? 0 : n,
    classification: baseValue(),
  });
}

const splitOptions = computed(() => {
  // the split refines a BASE line — "some of these are on my body, the rest are in
  // the pack". A consumable row has no base portion to split, so offering counts
  // there would silently demote the row to base on the first click. (The old
  // select carried the same guard.)
  if (isConsumable.value) return [];
  const counts = new Set<number>();
  for (let n = 1; n <= Math.min(props.item.qty - 1, MAX_SPLIT_OPTS); n++) counts.add(n);
  if (activeSplit.value > 0) counts.add(activeSplit.value);
  return [...counts].sort((a, b) => a - b);
});

// Short: these are the icons' NAMES, shown on hover. The popover behind each one
// carries the explanation, so a sentence here would only wrap the bubble across the
// row it is trying to describe.
const wornTitle = computed(() =>
  activeSplit.value > 0 ? `${activeSplit.value} of ${props.item.qty} worn` : "Worn",
);
const consumableTitle = "Consumable";

// The ACCESSIBLE name has to carry the STATE as well, which the tooltip text doesn't.
// These buttons replaced a <select aria-label="Classification">, which announced its
// value for free ("Worn", "Consumable", "Base"); a bare "Consumable, button" reads
// identically whether the row is consumable or not, so the only way to learn a row's
// class would be to open its popover. The visual signal is a grey chip — this is its
// spoken equivalent.
//
// aria-pressed is NOT the answer: these open a dialog rather than toggling on click,
// so a pressed state would describe something the click doesn't do. The name says it.
const wornAria = computed(() =>
  activeSplit.value > 0
    ? `Worn: ${activeSplit.value} of ${props.item.qty}`
    : isWorn.value
      ? "Worn: yes"
      : "Worn: no",
);
const consumableAria = computed(() => (isConsumable.value ? "Consumable: yes" : "Consumable: no"));

// the sub-line: the common name shows as an editable field whenever it's set (a catalog
// pick pre-fills it), the note is opt-in. The button reveals the empty fields so a common
// name / note can be added; each is cleared by emptying its own input.
const subOpen = ref(false);
const cnameRef = useTemplateRef<HTMLInputElement>("cnameRef");
const noteRef = useTemplateRef<HTMLInputElement>("noteRef");
// Editing the product name also offers the common name, so gear typed by hand (no catalog
// row to pre-fill it) has a visible place to put one — otherwise the only way in is the
// hover-only sub-line button, and a custom item looks like it simply can't have one. Set
// by focus landing anywhere in the name cell; held until focus leaves the ROW (so tabbing
// on to the field itself, or to qty/weight, doesn't yank it away mid-edit), then cleared
// by onRowBlur. An empty field just folds back up — nothing is written by revealing it.
const nameEditing = ref(false);
// A GROUP's own name is already the everyday label — that's where it comes from
// (useGearList.containerFor lifts the wrapped product's common name up to be the
// group's name), so offering a group a second one is circular. A parent therefore
// never opens the EMPTY field. A value it already carries still shows, so a row
// that acquired one before it became a group can still be read and cleared —
// never a stored value with no field to edit it.
const cnameShown = computed(
  () => !!props.item.commonName || ((subOpen.value || nameEditing.value) && !isParent.value),
);
const noteShown = computed(() => !!props.item.description || subOpen.value);
// the sub-line block shows when either field does — phrased off the two so a parent
// mid-name-edit doesn't open an empty reveal with nothing in it
const subShown = computed(() => cnameShown.value || noteShown.value);
// what the button can still bring on screen. A group never gets a gear-type field (see
// cnameShown), and a field showing a saved value is already there — so on a catalog-picked
// row, whose gear type is pre-filled, the only thing left to open is the note.
const hiddenFields = computed(() => {
  const f: string[] = [];
  if (!isParent.value && !cnameShown.value) f.push("gear type");
  if (!noteShown.value) f.push("note");
  return f;
});
// ONE name for this control, used as tooltip, accessible name AND ⋯-menu entry: a visible
// label that isn't contained in the accessible name is a WCAG 2.5.3 failure and leaves the
// button unhittable by speech input ("click Add a note" matching nothing).
const subLabel = computed(() => {
  const both = isParent.value ? "note" : "gear type & note";
  if (subOpen.value) return `Hide ${both}`;
  return hiddenFields.value.length ? `Add a ${hiddenFields.value.join(" or ")}` : `Edit ${both}`;
});
// the reveal's id, so the button can point at what it expands (aria-controls)
const subId = useId();
// Reveal the empty fields; toggling off hides them again (saved values keep showing and
// are edited/cleared in place). Focus goes to the field that actually APPEARED — on a
// catalog-picked row that's the note, not the gear type sitting there already.
function onSubBtn() {
  const opening = hiddenFields.value[0]; // read BEFORE the toggle invalidates it
  // nothing left to reveal: the click means "let me edit what's showing", not "open more"
  if (!subOpen.value && !opening) return void (cnameShown.value ? cnameRef : noteRef).value?.focus();
  subOpen.value = !subOpen.value;
  if (subOpen.value) nextTick(() => (opening === "gear type" ? cnameRef : noteRef).value?.focus());
}
// an opened-but-empty sub-line collapses when focus leaves BOTH fields with nothing typed;
// moving focus between the two sibling inputs keeps it open
function onSubBlur(e: FocusEvent) {
  const next = e.relatedTarget as HTMLElement | null;
  if (next && (next === cnameRef.value || next === noteRef.value)) return;
  if (
    !props.item.commonName &&
    !props.item.description &&
    !cnameRef.value?.value.trim() &&
    !noteRef.value?.value.trim()
  )
    subOpen.value = false;
}

// ---- mobile overflow (⋯) menu ----
// On mobile the trailing icons crowd the two-line row, so all of them EXCEPT delete
// + grip collapse into a ⋯ menu (note + the nesting actions). Desktop keeps the
// inline icons and never shows this. One menu open at a time across the list (shared
// singleton), and the folder lifts its collapse clip while it's open (overlayToggle).
const menu = useItemMenu();
const menuRootRef = useTemplateRef<HTMLElement>("menuRootRef");
// The singleton holds ONE open id for the whole list, so every popover a row can
// raise is namespaced off the row id (`<id>:menu`, `<id>:kcal`). That's what makes
// them mutually exclusive for free — opening the calorie popover closes the ⋯ menu,
// on this row or any other, with no cross-wiring between them.
const isMenuOpen = computed(() => menu.openId.value === `${props.item.id}:menu`);
watch(isMenuOpen, (open) => emit("overlayToggle", open));
function toggleMenu() {
  menu.toggle(`${props.item.id}:menu`, menuRootRef.value);
}

// ---- the two classification popovers ----
// Both hang off their own toggle and hold: a switch for the class itself, plus the
// one detail that only makes sense while it is on (worn → how many of the qty;
// consumable → calories). Same shape twice, so learning one teaches the other.
//
// Namespaced off the row id like the ⋯ menu, so the singleton's single openId makes
// every popover on every row mutually exclusive with no cross-wiring.
const wornRootRef = useTemplateRef<HTMLElement>("wornRootRef");
const isWornOpen = computed(() => menu.openId.value === `${props.item.id}:worn`);
watch(isWornOpen, (open) => emit("overlayToggle", open));
const wornAbove = ref(false);

// ---- calories (consumable rows only) ----
// Served in a popover hung off the classification control rather than given a
// column: kcal is a fact about food, and food is a minority of a minority of rows.
// A column would cost every row width to serve a few, which is the trade the
// classification select already makes by collapsing three states into one control.
const kcalRootRef = useTemplateRef<HTMLElement>("kcalRootRef");
const isKcalOpen = computed(() => menu.openId.value === `${props.item.id}:kcal`);
watch(isKcalOpen, (open) => emit("overlayToggle", open));

// Flip above the trigger when there isn't room below. A list is long and its last
// rows sit at the viewport floor, where a below-anchored popover opens off-screen —
// the one place the feature is needed is the one place it would be unreachable.
// Tooltip.vue solves the same problem but is built around a hover-driven popup
// teleported to <body>; this popover holds a focusable field and stays in the row,
// so it measures for itself rather than inheriting that machinery.
const kcalAbove = ref(false);
// generous: switch row + label + field + the optional line-total, plus a margin
const POP_H = 170;
const POP_EDGE = 8; // breathing room against the viewport edge

// How far the popover must slide right to stay on screen. It hangs off the trigger's
// RIGHT edge, which is correct on a wide row but walks off the left of a phone, where
// the stacked layout puts the toggles near the middle of a 375px viewport. Measured
// rather than handled in CSS: only the trigger's live position can say whether the
// card fits, and the same open-time measurement already decides the vertical flip.
const popShift = ref(0);

/** Open (or close) one of the row's classification popovers, flipping it above the
 *  trigger when the row sits too close to the viewport floor. `focusField` is false
 *  for the worn popover, whose controls are a switch and a set of buttons — pulling
 *  focus to the first of those would look like a selection had been made. */
async function togglePop(
  kind: "worn" | "kcal",
  rootRef: HTMLElement | null,
  above: { value: boolean },
  isOpen: boolean,
  focusField: boolean,
) {
  const opening = !isOpen;
  if (opening) {
    const r = rootRef?.getBoundingClientRect();
    above.value = !!r && window.innerHeight - r.bottom < POP_H;
    popShift.value = 0; // measured below, once the card exists
  }
  menu.toggle(`${props.item.id}:${kind}`, rootRef);
  if (!opening) return;
  await nextTick();
  // Measure the rendered card rather than trusting a constant: its width is set in
  // CSS (rem), so a hardcoded pixel twin is wrong the moment the root font size
  // isn't 16, and it drifts silently if the rule is ever retuned.
  //
  // offsetWidth, NOT getBoundingClientRect — the same trap Tooltip.vue documents.
  // This runs on the tick the card mounts, while the enter transform is still
  // applied, and a client rect reports the TRANSFORMED box (it measured 2px off).
  // offsetWidth is the untransformed layout box. The TRIGGER isn't animating, so
  // its rect is sound, and the card's left edge is the trigger's right minus that
  // width — which is exactly where the CSS pins it.
  const card = rootRef?.querySelector<HTMLElement>(".item__pop");
  const anchor = rootRef?.getBoundingClientRect();
  if (card && anchor) {
    const left = anchor.right - card.offsetWidth;
    if (left < POP_EDGE) popShift.value = POP_EDGE - left;
  }
  if (focusField) {
    // focus the field on open — the popover exists to take one number, so landing
    // anywhere else would make every use a click plus a tab
    rootRef?.querySelector<HTMLInputElement>("input")?.focus();
  }
}

const toggleWorn = () => togglePop("worn", wornRootRef.value, wornAbove, isWornOpen.value, false);
const toggleKcal = () => togglePop("kcal", kcalRootRef.value, kcalAbove, isKcalOpen.value, true);
function onKcal(e: Event) {
  const el = e.target as HTMLInputElement;
  const raw = el.value.trim();
  // "" (and anything unparseable) clears — the reducer treats a non-number as
  // absent rather than 0, so an emptied field means "not filled in", not "zero
  // calories". Resync afterwards so a rejected entry doesn't linger in the box.
  const n = raw === "" ? null : Number(raw);
  c.updateItem(props.item.id, { kcal: n != null && isFinite(n) ? n : null });
  el.value = props.item.kcal ? String(props.item.kcal) : "";
}
// ---- nesting ----
// The two actions a row can offer, resolved to whichever apply. Same table-drives-
// both-markup-and-dispatch shape the editor's ⋯ menu uses, so an action can't exist
// in one without the other.
const nestActions = computed(() => {
  const acts: { label: string; run: () => void }[] = [];
  // a nested row can't nest further, and a row that already HAS children uses its
  // own ever-present "Add an item" instead
  if (!props.nested && !isParent.value) acts.push({ label: "Add a nested item", run: () => c.addChild(props.item.id) });
  if (props.nested) acts.push({ label: "Move out of the group", run: () => c.unnest(props.item.id) });
  else if (canIndent.value && props.prevId)
    acts.push({ label: "Nest under the item above", run: () => c.nestItem(props.item.id, props.prevId!) });
  return acts;
});
const nestRootRef = useTemplateRef<HTMLElement>("nestRootRef");
const isNestOpen = computed(() => menu.openId.value === `${props.item.id}:nest`);
watch(isNestOpen, (open) => emit("overlayToggle", open));
function toggleNestMenu() {
  menu.toggle(`${props.item.id}:nest`, nestRootRef.value);
}

// ---- save to vault ----
// Gear reaches the vault on its own as you build (useVault.sync), which is the right
// default and the reason the vault fills itself. What it has never had is a way to
// SAY so: no button, no confirmation, nothing on the row that admits the feature
// exists. This is that affordance — the same capture, asked for out loud.
//
// And the button exists only while pressing it could DO the thing it names —
// two gates, one on each side of the row's life:
//  • Not yet gear: a row with no name, or no weight and no catalog link, has
//    nothing to save (isVaultWorthy — capture's own rule; groups and water are
//    out the same way). The old always-present button's only outcome there was a
//    toast telling you to finish the row — so a NEW item shows no icon at all,
//    and finishing the row is what makes it arrive (the reveal below).
//  • Already banked: when the automatic path has the row, asking out loud is
//    offering to do what's done — so the button leaves again. (It used to stay,
//    dimmed and aria-disabled, reading "Already in My Gear".) Covered is true
//    exactly when every gate the automatic path runs is open for this worthy row:
//    there's a vault to reach (signed in), this list's answer is yes
//    (c.vaultAuto), and the chooser didn't decline it. Fail one of those and the
//    worthy row keeps its button, because pressing it is then the only way this
//    row gets banked.
//
// Neither gate can race live typing: they read the committed snapshot, and the
// fields that feed worthiness settle before they commit — the name on
// enter/blur/pick (ItemInput.commitFree), the weight on change — never per
// keystroke. So the button arrives once, when the row's facts do, not letter by
// letter. (On a covered list both gates flip in the same commit, worthy AND
// covered, so completing a row there never flashes a button it's about to take.)
const vaultWorthy = computed(() => isVaultWorthy(props.item, isParent.value));
const vaultCovered = computed(
  () =>
    hasVault.value &&
    c.vaultAuto.value &&
    vaultWorthy.value &&
    !c.vaultDeclined.value.has(vaultNormKey(props.item.brand, props.item.name, props.item.variant)),
);
const vaultSaved = ref(false);
const vaultBusy = ref(false);
const vaultLabel = computed(() =>
  vaultSaved.value ? "Saved to My Gear" : "Save to My Gear",
);
async function onSaveToVault() {
  // a covered row renders no button, but coverage can flip mid-press (the chooser
  // and the vault answer live outside the row) — the covered guard makes that
  // beat a no-op instead of a save the automatic path already made
  if (vaultBusy.value || vaultSaved.value || vaultCovered.value) return;
  vaultBusy.value = true;
  const result = await c.saveItemToVault(props.item.id);
  vaultBusy.value = false;
  if (result === "saved") return void (vaultSaved.value = true);
  emit(
    "toast",
    result === "unworthy"
      ? "Give the row a name and a weight first"
      // the vault belongs to an account, so signed out there is nowhere to put it.
      // Naming that is the difference between a dead button and a next step.
      : hasVault.value
        ? "Couldn’t reach My Gear — try again in a moment"
        : "Sign in to keep your gear",
  );
}
// a rename or re-weigh makes it a different piece of gear, so the tick stops
// speaking for it and the row can be banked again
watch(
  () => [props.item.name, props.item.brand, props.item.variant, props.item.unitWeightMg],
  () => (vaultSaved.value = false),
);

// the same actions the inline icons run: note first (the most-edited thing here),
// then the one nesting action that applies to this row's state (add-nested / nest-up /
// un-nest), then the vault save, and last the removal — all inline on a desktop row
// and living only here on a phone (see the mobile block: the trailing cluster is
// ⋯ · grip, because the icons are --tap wide there and the line has no room for the
// row's numbers beside more than two of them).
const overflowActions = computed(() => {
  const acts: { label: string; run: () => void }[] = [
    { label: subLabel.value, run: onSubBtn },
  ];
  if (props.nested) acts.push({ label: "Un-nest", run: () => c.unnest(props.item.id) });
  else {
    if (!isParent.value) acts.push({ label: "Add a nested item", run: () => c.addChild(props.item.id) });
    if (canIndent.value)
      acts.push({ label: "Nest under the item above", run: () => props.prevId && c.nestItem(props.item.id, props.prevId) });
  }
  // Reads its own state, like the inline button's tooltip does — "Saved" is the
  // whole feedback here, since a menu closes on choosing and there's no tick left
  // on screen to see. Same disclosure rule as the inline icon: no entry until the
  // row is gear worth saving, none again once the automatic path has it (it used
  // to stay as a disabled "Already in My Gear" line) — a menu row that can only
  // say "nothing to do" is an action list advertising a non-action.
  if (!isWater.value && vaultWorthy.value && !vaultCovered.value)
    acts.push({ label: vaultLabel.value, run: onSaveToVault });
  // LAST, the way the destructive icon sat last in the desktop cluster — a menu is a
  // list you read top to bottom, so the one irreversible entry belongs at the end of
  // it rather than under the thumb. Same words as the icon it replaces ("Remove item",
  // its aria-label and its tooltip), so the action has one name wherever it appears.
  acts.push({ label: "Remove item", run: () => c.removeItem(props.item.id) });
  return acts;
});
function runOverflow(a: { run: () => void }) {
  menu.close();
  a.run();
}

// "Fix for everyone": only offered once the user's weight diverges from the
// catalog value they linked — i.e. they think the canonical spec is wrong.
// A plain free-typed override (no catalog link) never nags.
// (Its old `!packed` term moved to CSS with the rest of the mode gating — packing
// hides the whole under-row reveal; atoms/item.scss.)
const correction = useCatalogCorrection();
const showFix = computed(
  () =>
    props.item.catalogItemId != null &&
    props.item.catalogWeightMgAtLink != null &&
    props.item.unitWeightMg > 0 &&
    props.item.unitWeightMg !== props.item.catalogWeightMgAtLink,
);
function openFix() {
  if (props.item.catalogItemId == null || props.item.catalogWeightMgAtLink == null) return;
  correction.open({
    catalogItemId: props.item.catalogItemId,
    itemName: props.item.name,
    catalogWeightMg: props.item.catalogWeightMgAtLink,
    suggestedMg: props.item.unitWeightMg,
    displayUnit: props.list.displayUnit,
  });
}
// dismiss the nudge from the page: re-baseline the linked catalog weight to the
// current weight, so it no longer diverges (persists; re-offers if they edit again)
function dismissFix() {
  c.updateItem(props.item.id, { catalogWeightMgAtLink: props.item.unitWeightMg });
}
</script>

<template>
  <!-- one wrapper for BOTH modes, so a parent row's nested children render (and are
       checkable) in packing mode too — the packed branch swaps only the row itself -->
  <div
    ref="wrapRef"
    class="item-wrap"
    :data-item-id="item.id"
    :data-parent="item.parentId || null"
    :class="{ 'is-dragging': isDragging, 'is-drop-before': isDropBefore, 'is-nest-parent': isNestParent }"
    @focusout="onRowBlur"
  >
    <!-- editing↔packing swap, decided by CSS rather than by this component. Which face
         shows follows the editor body's data-mode (atoms/item.scss); the fade the old
         <Transition> gave the entering face is a CSS animation there, gated on the
         body's is-rowswitching beat so it plays exactly when a switch happens and not
         when a row appears for any other reason. What this template decides is only
         whether each face has ever been NEEDED (the useEditorMode latches): a face
         mounts the first time its mode is entered and then stays for the page's life,
         display:none'd in the other modes. So a mode switch mounts nothing, unmounts
         nothing, and re-renders nothing here — flipping one body attribute is the
         entire act. The checklist face never mounts for a list that never enters
         packing mode, and a list OPENED in packing builds no edit faces either. -->
      <label v-if="everPacked" class="item-row item item--check" :class="{ 'item--done': item.packed }">
      <!-- checkbox visuals come from the icon set (Square empty / SquareCheck checked —
           the same glyph as the header's packing toggle, and the two share an identical
           outer square so the swap reads as the tick appearing); the real <input> stays
           on top, invisible but focusable, so behavior + focus stay native -->
      <span class="item__boxwrap">
        <input
          type="checkbox"
          class="item__box"
          :checked="item.packed"
          :aria-label="`Packed: ${editableName || 'item'}`"
          @change="c.updateItem(item.id, { packed: ($event.target as HTMLInputElement).checked })"
        />
        <!-- absolute-stroke-width pins the drawn line at ~1.33px — what the surrounding
             16px icons render (2 nominal × 16/24) — so the bigger box doesn't read bolder
             than its row -->
        <HugeiconsIcon :icon="SquareIcon" class="item__boxicon item__boxicon--empty" :size="20" :stroke-width="1.33" absolute-stroke-width aria-hidden="true" />
        <HugeiconsIcon :icon="CheckmarkSquare02Icon" class="item__boxicon item__boxicon--check" :size="20" :stroke-width="1.33" absolute-stroke-width aria-hidden="true" />
      </span>
      <span class="item__cname" :class="{ 'item__cname--group': isParent }"><ItemName :item="item" :group="isParent" /><button
          v-if="isParent"
          class="item__nestcollapse"
          :aria-expanded="!nestCollapsed"
          :aria-label="`${nestCollapsed ? 'Expand' : 'Collapse'} ${item.name || 'group'}`"
          :title="nestCollapsed ? 'Expand group' : 'Collapse group'"
          @mousedown.prevent
          @click.stop.prevent="toggleNest"
        ><HugeiconsIcon :icon="ChevronDownIcon" class="item__nestchev" :class="{ 'is-collapsed': nestCollapsed }" :size="16" :stroke-width="2" /></button></span>
      <!-- `item__qty--split` widens the amount track for the whole page column when any
           row in the list spells out a worn split ("×12 · 11 worn") — atoms/item.scss -->
      <span class="t-num t-sm t-muted item__cqty" :class="{ 'item__qty--split': activeSplit }">{{ itemQtyLabel(item, effClass) }}</span>
      <!-- the empty unit slot keeps the zero placeholder in the number's place rather
           than out at the cell's edge — same as the read row's -->
      <span class="t-num item__cweight"><template v-if="rowWeightMg > 0">{{ formatWeight(rowWeightMg, rowUnit, { withUnit: false }) }}<span class="t-muted item__wunit">{{ rowUnit }}</span></template><template v-else>—<span class="item__wunit" /></template></span>
      <!-- the common name — a quiet sub-line under the product name (what you're checking
           off), aligned to the name column past the checkbox; mirrors the read row -->
      <span v-if="item.commonName" class="t-sm item__csub">{{ item.commonName }}</span>
    </label>

    <div v-if="everEdit" class="item-row item">
      <!-- editable row (default) -->
      <!-- focusin (it bubbles, unlike focus) rather than binding ItemInput's own input:
           the name cell is the whole "what is this item" affordance, so landing anywhere
           in it offers the common name below (see nameEditing) -->
      <div class="item__name" :class="{ 'item__name--group': isParent }" @focusin="nameEditing = true">
        <ItemInput
          :unit="list.displayUnit"
          :initial="editableName"
          placeholder="Item name"
          :clear-on-commit="false"
          :autofocus="isPendingBlank"
          @commit="onNameCommit"
          @advance="c.addBlankItemAfter(item.id)"
          @overlay-toggle="$emit('overlayToggle', $event)"
        />
        <!-- collapse a group of nested items — trails the name like the folder's
             chevron (the name hugs its text so this sits right after it) -->
        <button
          v-if="isParent"
          class="item__nestcollapse"
          :aria-expanded="!nestCollapsed"
          :aria-label="`${nestCollapsed ? 'Expand' : 'Collapse'} ${item.name || 'group'}`"
          :title="nestCollapsed ? 'Expand group' : 'Collapse group'"
          @mousedown.prevent
          @click="toggleNest"
        >
          <HugeiconsIcon :icon="ChevronDownIcon" class="item__nestchev" :class="{ 'is-collapsed': nestCollapsed }" :size="16" :stroke-width="2" />
        </button>
      </div>

      <!-- metadata + controls: display:contents on desktop, so qty/weight/class/
           actions drop into the shared grid columns; on mobile the wrapper turns
           into a flex-wrap row beneath the full-width name so long names never
           truncate (the name takes the whole row, the rest wraps below) -->
      <div class="item__meta">
        <div class="item__qty">
          <input
            class="field field--num"
            type="number"
            :min="isWater ? 0 : 1"
            :step="isWater ? 'any' : 1"
            :value="isWater ? litersDisplay : item.qty"
            :aria-label="isWater ? 'Litres of water' : 'Quantity'"
            @change="isWater ? onWaterLiters($event) : onQty($event)"
          />
          <span class="t-sm t-muted item__unit">{{ isWater ? "L" : "×" }}</span>
        </div>

        <div class="item__weight">
          <input
            class="field field--num"
            :value="isParent ? groupWeight : weightDisplay"
            placeholder="--"
            aria-label="Weight"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            :readonly="isWater || isParent"
            :title="isParent ? 'Total of this group (its nested items)' : undefined"
            @focus="onWeightFocus"
            @change="onWeight"
            @keydown.up.prevent="onWeightStep($event, 1)"
            @keydown.down.prevent="onWeightStep($event, -1)"
          />
          <!-- The unit is SELECTABLE, not just typed. Entry units already worked by
               typing "3.8 oz", but that only helps if you know to try it — the label
               looked like a caption, so the feature was invisible. Same transparent-
               native-select idiom the total's unit uses (TotalsBar): the visible text
               stays exactly as it was, and the real control sits over it keeping the
               native picker and full keyboard behaviour.
               Not on water (its weight is derived from a volume) or on a group row
               (whose figure is the sum of children that may each read differently). -->
          <!-- Water and group rows show the unit as plain text: water's weight is
               derived from a volume, and a group's figure is the sum of children that
               may each read differently, so neither has a unit to pick. -->
          <span v-if="isWater || isParent" class="item__unitwrap">
            <span class="t-sm t-muted item__unit">{{ rowUnit }}</span>
            <!-- The chevron's SLOT, held open by the chevron itself.
                 These rows have no unit to pick, so they carry no picker — and without
                 the mark their cell is 20px narrower than every editable row's. On the
                 desktop grid that hid inside a fixed column, but the mobile meta line is
                 a flowing flex row, so those 20px moved the whole pair and a water row's
                 figure sat out of line with the rows above it.
                 Rendered rather than padded: a hardcoded width is a second copy of the
                 chevron's size that goes stale the moment the icon changes. This one
                 cannot drift, because it IS the icon. -->
            <HugeiconsIcon
              :icon="ChevronDownIcon"
              class="item__unitchev item__unitchev--ghost"
              :size="12"
              :stroke-width="2"
              aria-hidden="true"
            />
          </span>
          <OptionMenu
            v-else
            class="item__unitwrap"
            :options="UNIT_OPTIONS"
            :current="rowUnit"
            label="Weight unit for this item"
            :title="`Unit for ${item.name || 'this item'}`"
            @pick="(u) => onRowUnit(u as Unit)"
          >
            <template #trigger="{ open }">
              <span class="t-sm t-muted item__unit">{{ rowUnit }}</span>
              <!-- The mark that says "this is a control". Without it the unit was text
                   that looked exactly like a caption, so the picker was only ever found
                   by accident. Same chevron the total's unit carries, at row scale —
                   one vocabulary for one gesture. 12/2 renders an exact 1px stroke
                   (12 ÷ 24 × 2), the small-size counterpart to the total's 16/2.25. -->
              <HugeiconsIcon
                :icon="ChevronDownIcon"
                class="item__unitchev"
                :class="{ 'is-open': open }"
                :size="12"
                :stroke-width="2"
                aria-hidden="true"
              />
            </template>
          </OptionMenu>
        </div>

        <!-- CLASSIFICATION — two toggles rather than a three-option select. The field
             holds one value with base stored as null, so "both off" IS base: the pair
             renders the type directly instead of restating it. Each toggle also opens
             the one detail that only exists while it is on — worn's split count,
             consumable's calories — so the row itself gains no third control.
             CONSUMABLE FIRST, worn second. Water is why: its class is fixed, so its
             row draws a lit mark instead of a toggle — and only with consumable in
             the leading slot does that mark land in the same column as every other
             row's cookie (the worn slot beside it is held open by a ghost below). -->
        <div class="item__classcell">
          <div v-if="!isWater" ref="kcalRootRef" class="menu item__cls">
            <Tooltip :text="consumableTitle" :disabled="isKcalOpen" preferred-placement="top">
              <button
                class="btn btn--icon btn--ghost menu__btn item__clsbtn"
                :class="{ 'item__mark': isConsumable }"
                type="button"
                aria-haspopup="dialog"
                :aria-expanded="isKcalOpen"
                :aria-label="consumableAria"
                @mousedown.prevent
                @click="toggleKcal"
              >
                <HugeiconsIcon :icon="CookieIcon" :size="16" :stroke-width="2" />
              </button>
            </Tooltip>
            <Transition name="menu">
              <div
                v-if="isKcalOpen"
                class="popover item__pop"
                :class="{ 'is-above': kcalAbove }"
                :style="popShift ? { translate: popShift + 'px 0' } : undefined"
                role="dialog"
                aria-label="Consumable"
              >
                <div class="switch-row">
                  <span class="t-sm">Consumable</span>
                  <button
                    class="switch"
                    type="button"
                    role="switch"
                    :aria-checked="isConsumable"
                    aria-label="Food, fuel or water"
                    @click="setClass('consumable', !isConsumable)"
                  />
                </div>
                <!-- calories only once the row IS consumable — that is the only state
                     in which the number is counted, so offering it before would collect
                     a value the totals ignore -->
                <template v-if="isConsumable">
                  <label class="t-sm t-muted item__poplabel" :for="`${item.id}-kcal`">kcal each</label>
                  <input
                    :id="`${item.id}-kcal`"
                    class="field field--num item__popinput"
                    :value="item.kcal ?? ''"
                    placeholder="0"
                    inputmode="numeric"
                    autocomplete="off"
                    spellcheck="false"
                    @change="onKcal"
                    @keydown.enter="($event.target as HTMLInputElement).blur()"
                  />
                  <!-- the line total, so a qty>1 row doesn't make you do it in your
                       head. The icon marks it as DERIVED — everything above it in this
                       popover is something you typed, this is the one line the app
                       worked out. -->
                  <p v-if="item.kcal && item.qty > 1" class="t-sm t-muted item__popline">
                    <HugeiconsIcon :icon="CalculateIcon" class="item__poplineicon" :size="14" aria-hidden="true" :stroke-width="2" />
                    {{ formatKcal(item.kcal * item.qty) }} kcal for {{ item.qty }}
                  </p>
                </template>
              </div>
            </Transition>
          </div>
          <!-- water's mark, not a toggle: its class can't change and it has no
               calories to hold, so a switch and a kcal field here would both be
               controls that lie. The read view draws this same lit cookie. -->
          <div v-else class="item__cls">
            <Tooltip text="Consumable" preferred-placement="top">
              <span class="item__clsfixed item__mark" role="img" aria-label="Consumable">
                <HugeiconsIcon :icon="CookieIcon" :size="16" :stroke-width="2" />
              </span>
            </Tooltip>
          </div>

          <div v-if="!isWater" ref="wornRootRef" class="menu item__cls">
            <!-- Tooltip wraps the BUTTON, not the cell: the popover below is anchored
                 to .item__cls, and putting the wrapper around both would re-anchor it
                 to a div that only spans the trigger. The accessible name stays on the
                 control (aria-label) — the tooltip only adds the visible description,
                 so `title` is dropped to avoid the native bubble doubling it. -->
            <Tooltip :text="wornTitle" :disabled="isWornOpen" preferred-placement="top">
              <button
                class="btn btn--icon btn--ghost menu__btn item__clsbtn"
                :class="{ 'item__mark': isWorn }"
                type="button"
                aria-haspopup="dialog"
                :aria-expanded="isWornOpen"
                :aria-label="wornAria"
                @mousedown.prevent
                @click="toggleWorn"
              >
                <HugeiconsIcon :icon="ShirtIcon" :size="16" :stroke-width="2" />
              </button>
            </Tooltip>
            <Transition name="menu">
              <div
                v-if="isWornOpen"
                class="popover item__pop"
                :class="{ 'is-above': wornAbove }"
                :style="popShift ? { translate: popShift + 'px 0' } : undefined"
                role="dialog"
                aria-label="Worn"
              >
                <div class="switch-row">
                  <span class="t-sm">Worn</span>
                  <button
                    class="switch"
                    type="button"
                    role="switch"
                    :aria-checked="isWorn"
                    aria-label="Worn on your body"
                    @click="setClass('worn', !isWorn)"
                  />
                </div>
                <!-- the split: only offered on a row with multiples, because one of one
                     is simply "worn". Buttons rather than a number field — the useful
                     range is 1..qty-1 and it is nearly always 1. The label matches the
                     consumable popover's ("kcal each"): a field label naming the value
                     below it, not a sentence. -->
                <template v-if="splitOptions.length">
                  <p class="t-sm t-muted item__poplabel">worn of {{ item.qty }}</p>
                  <div class="item__splits">
                    <button
                      v-for="n in splitOptions"
                      :key="n"
                      class="btn btn--quiet item__split"
                      :class="{ 'is-active': activeSplit === n }"
                      type="button"
                      :title="`${n} worn, ${Math.max(0, item.qty - n)} in the pack`"
                      @click="setSplit(n)"
                    >
                      {{ n }}
                    </button>
                  </div>
                  <!-- the resolved split, mirroring the calorie popover's line total:
                       both popovers end by restating what the row now counts as -->
                  <p v-if="activeSplit > 0" class="t-sm t-muted item__popline">
                    {{ activeSplit }} worn · {{ Math.max(0, item.qty - activeSplit) }} packed
                  </p>
                </template>
              </div>
            </Transition>
          </div>
          <!-- the worn SLOT, held open by the icon itself — the unit chevron's ghost
               recipe. Water can't be worn, but the cell must stay two slots wide:
               the mobile line right-anchors this cell, so a one-slot cell would pull
               water's lone mark out of the cookie column it exists to sit in. -->
          <div v-else class="item__cls" aria-hidden="true">
            <span class="item__clsfixed item__clsghost">
              <HugeiconsIcon :icon="ShirtIcon" :size="16" :stroke-width="2" />
            </span>
          </div>
        </div>

        <div class="item__actions">
          <!-- mousedown.prevent on the action buttons: on macOS Safari/Firefox a
               button does NOT take focus on mousedown, so clicking one from a
               focused input blurs the row (relatedTarget null) and a pristine
               blank row discards itself before the click can act (e.g. the note
               button would delete the row instead of opening the note field).
               Preventing the default keeps focus where it was; click still fires. -->
          <!-- Save to vault. Capture already happens on its own as you build, so this
               isn't a new capability — it's the missing affordance for one that had no
               visible existence.
               Rendered only while pressing it would DO something: not before the row
               is gear worth saving (vaultWorthy — a new item carries no icon; naming
               and weighing it is what makes this arrive), and not after the automatic
               path has it (vaultCovered — the button doesn't stand down, it steps
               out). Same disclosure rule as the nesting menu below, which also only
               exists while it has an action to offer. It sits FIRST in the cluster,
               at the open left edge, because it's the one icon here that comes and
               goes per row: the cluster is right-aligned, so a conditional icon in
               the middle would shuffle its neighbours from row to row, while out
               here its absence moves nothing.
               Not on water rows, the same rule the ⋯ menu applies: water is never
               gear (isVaultWorthy), so the button's only possible outcome there was
               a toast telling you to weigh a row that has a weight. -->
          <Transition name="vaultin">
            <Tooltip v-if="!isWater && vaultWorthy && !vaultCovered" :text="vaultLabel" preferred-placement="top">
              <button
                class="btn btn--icon btn--ghost item__vault-btn"
                :class="{ 'is-active': vaultSaved }"
                type="button"
                :disabled="vaultBusy"
                :aria-label="vaultLabel"
                @mousedown.prevent
                @click="onSaveToVault"
              >
                <HugeiconsIcon :icon="CheckIcon" v-if="vaultSaved" :size="16" :stroke-width="2" />
                <HugeiconsIcon :icon="SafeBoxIcon" v-else :size="16" :stroke-width="2" />
              </button>
            </Tooltip>
          </Transition>
          <!-- NESTING, under one icon. These were up to two adjacent buttons whose
               glyphs (list-plus, indent, outdent) are near-identical at 16px, so the
               cluster read as noise and you had to hover each to learn which was which.
               One trigger, and the menu SAYS what each action does.
               Rendered only when there is something to offer — a nested row that can't
               un-nest, or a parent with nothing to indent under, gets no icon at all
               rather than a menu that opens empty. -->
          <div v-if="nestActions.length" ref="nestRootRef" class="menu item__nest">
            <Tooltip text="Nesting" preferred-placement="top" :disabled="isNestOpen">
              <button
                class="btn btn--icon btn--ghost item__nest-btn"
                type="button"
                aria-haspopup="menu"
                :aria-expanded="isNestOpen"
                aria-label="Nesting"
                @mousedown.prevent
                @click="toggleNestMenu"
              >
                <HugeiconsIcon :icon="ListIndentIncreaseIcon" :size="16" :stroke-width="2" />
              </button>
            </Tooltip>
            <Transition name="menu">
              <ul v-if="isNestOpen" class="popover menu__list item__nestlist" role="menu" aria-label="Nesting">
                <li v-for="a in nestActions" :key="a.label" role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="menu.close(); a.run()">{{ a.label }}</button>
                </li>
              </ul>
            </Transition>
          </div>
          <Tooltip text="Remove item" preferred-placement="top">
            <button
              class="btn btn--icon btn--ghost item__del"
              aria-label="Remove item"
              @mousedown.prevent
              @click="c.removeItem(item.id)"
            >
              <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="2" />
            </button>
          </Tooltip>
          <Tooltip :text="subLabel" preferred-placement="top">
            <button
              class="btn btn--icon btn--ghost item__note-btn"
              :class="{ 'is-active': !!item.description }"
              :aria-label="subLabel"
              :aria-expanded="subShown"
              :aria-controls="subId"
              @mousedown.prevent
              @click="onSubBtn"
            >
              <HugeiconsIcon :icon="NoteRemoveIcon" v-if="subOpen" :size="16" :stroke-width="2" />
              <HugeiconsIcon :icon="NoteAddIcon" v-else :size="16" :stroke-width="2" />
            </button>
          </Tooltip>
          <!-- mobile overflow: the note + nesting actions collapse in here (delete +
               grip stay inline). Hidden on desktop. Same .menu/.popover atom as the
               editor's ⋯ kebab; one row's menu open at a time (useItemMenu). -->
          <div ref="menuRootRef" class="menu item__more">
            <button
              class="btn btn--icon btn--ghost menu__btn item__morebtn"
              type="button"
              aria-haspopup="menu"
              :aria-expanded="isMenuOpen"
              aria-label="More actions"
              @mousedown.prevent
              @click="toggleMenu"
            >
              <HugeiconsIcon :icon="CircleEllipsisIcon" :size="16" :stroke-width="2" />
            </button>
            <Transition name="menu">
              <ul v-if="isMenuOpen" class="popover menu__list item__morelist" role="menu" aria-label="Item actions">
                <li v-for="a in overflowActions" :key="a.label" role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="runOverflow(a)">{{ a.label }}</button>
                </li>
              </ul>
            </Transition>
          </div>
          <!-- drag via pointerdown; arrow keys give the focused grip the reordering
               its label promises (a drag needs a pointer) -->
          <button
            class="btn btn--icon btn--ghost item__grip"
            title="Drag to reorder"
            :aria-label="`Reorder ${item.name || 'item'}`"
            @pointerdown="dnd.start(item.id, $event)"
            @keydown="onGripKey"
          >
            <HugeiconsIcon :icon="GripVerticalIcon" :size="16" :stroke-width="2" />
          </button>
        </div>
      </div>
    </div>

    <!-- sub-line: the common name (a quiet upright label) and, under it, the freeform note;
         both single-line live-text fields, appearing once either has content or the details
         button is clicked. Editing only: the checklist row shows a saved gear type as plain
         text (.item__csub) and no note at all — nothing there is editable. (The "editing
         only" half is CSS now — packing hides every under-row reveal; atoms/item.scss.)
         The .reveal wrapper is a grid whose row animates 1fr↔0fr (Safari-safe slide); the two
         inputs share one inner child so that single-child slide stays clean. -->
    <Transition name="reveal">
      <div v-if="subShown" :id="subId" class="reveal reveal--note">
        <div class="item__subfields">
          <!-- the gear-type field's placeholder is EXAMPLES ONLY, no concept noun: it sits
               directly under the product name, so the contrast (a specific product / the
               everyday word for it) is what explains it — naming the abstraction there is
               what read as jargon. The aria-label carries the noun for screen readers,
               which have no such positional context.
               The three examples are the three most common types in the catalog itself
               (backpack 237 rows, tent 118, quilt 107 — seed/common-names.json), so they
               are real canonical values, spelled as the vocabulary spells them. The old
               "Shoes" was neither: no row carries it (footwear is "trail runners" /
               "hiking shoes"), so the field was advertising a value it would never fill in. -->
          <input
            v-if="cnameShown"
            ref="cnameRef"
            class="item__note item__gtype-input"
            :value="item.commonName ?? ''"
            placeholder="Tent, Backpack, Quilt…"
            aria-label="Gear type"
            autocorrect="off"
            spellcheck="true"
            @change="onCommonName"
            @blur="onSubBlur"
          />
          <input
            v-if="noteShown"
            ref="noteRef"
            class="item__note"
            :value="item.description ?? ''"
            placeholder="Add a note"
            aria-label="Item note"
            autocorrect="off"
            spellcheck="true"
            @change="onNote"
            @blur="onSubBlur"
          />
        </div>
      </div>
    </Transition>

    <Transition name="reveal">
      <div v-if="showFix" class="reveal">
        <div class="item__fixrow">
          <button type="button" class="item__under-link t-sm" @click="openFix">
            Catalog: {{ formatWeight(item.catalogWeightMgAtLink ?? 0, list.displayUnit) }} · suggest a fix
          </button>
          <button
            type="button"
            class="btn btn--icon btn--ghost item__fixdismiss"
            title="Dismiss"
            aria-label="Dismiss suggestion"
            @click="dismissFix"
          >
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
          </button>
        </div>
      </div>
    </Transition>

    <!-- nested items: the SAME row, one level down (checklist rows in packing mode), in a
         block indented behind a hairline thread line. Their real weights sum into this row's
         weight column. New children come from the ListPlus action above OR the ever-present
         "Add an item" below (mirrors the folder's, so growing a group doesn't need a hover). -->
    <div
      v-if="!nested && isParent"
      class="nestcollapse"
      :class="{ 'is-lifted': nestLifted }"
      :data-collapsed="nestCollapsed || null"
    >
      <div class="item-nest nest-block">
        <ItemRow
          v-for="child in children"
          :key="child.id"
          :list="list"
          :item="child"
          :children-by-parent="childrenByParent"
          nested
          @overlay-toggle="onChildOverlay"
          @toast="$emit('toast', $event)"
        />
        <div v-if="isNestAppendTarget" class="item-nest__droptail" aria-hidden="true" />
        <!-- hidden in packing by the mode CSS (atoms/item.scss), not a v-if — the row
             must not re-render on a mode switch, and this button is part of the row -->
        <button type="button" class="item-nest__add" @mousedown.prevent @click="c.addChild(item.id)">
          Add an item
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.item {
  /* the grid scaffold (display / columns / align / gap) is the shared .item-row base
     (atoms/item.scss); this row only feeds it the edit column token and lays its cells
     into named areas. names sit flush at the page edge; the note + remove + grip live
     together in one trailing actions cluster (evenly spaced, same vertical centre). */
  --row-cols: var(--item-cols);
  grid-template-areas: "name qty weight class actions";
  /* vertical padding comes from the row wrapper (.folder__items > *) so the rule
     lines between items sit at a consistent rhythm */
}
/* position:relative makes the name cell the autocomplete dropdown's anchor, so
   the menu opens flush with the row's left edge and its width math is cell-based
   (see ItemInput .ac__menu) — the .ac root inside defers via position:static. */
.item__name {
  grid-area: name;
  position: relative;
  min-width: 0;
}
.item__name :deep(.ac) {
  position: static;
}
/* a GROUP (parent) row: the name hugs its text so the collapse chevron trails it,
   exactly like a folder header (.folder__title / .folder__name / .folder__collapse) */
.item__name--group {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
}
.item__name--group :deep(.ac) {
  flex: 0 1 auto;
  min-width: 0;
}
.item__name--group :deep(.ac__input) {
  width: auto;
  field-sizing: content;
  min-width: 2ch;
  /* cap so a LONG name truncates (ellipsis, from .ac__input) instead of growing the
     field-sizing input until it shoves the chevron off the row edge. The cap is
     VIEWPORT-relative (like the folder's 50vw) — a `%` cap is useless here because the
     field-sizing input grows its own row, so `100%` resolves to the grown width. The
     5rem reserve leaves room for the chevron + the row gutter; it still hugs short
     names so the chevron trails them tightly. */
  max-width: min(40ch, calc(100vw - 5rem));
}
/* the collapse chevron button + its rotate + touch tap target are the shared
   .item__nestcollapse / .item__nestchev recipe in atoms/item.scss — one recipe for
   the edit row, the packing row (.item__cname--group below), and the share views. */
.item__qty {
  grid-area: qty;
}
.item__weight {
  grid-area: weight;
}
/* the cell, not a classification wrapper, is what the grid places — both toggles
   ride in the same column the word "Consumable" used to occupy.
   CENTRED, not baseline: the row aligns on the baseline, which lines up the TOPS of
   a 32px icon button and a 36px field and so leaves every icon sitting 2px high
   against the numbers. That was invisible while this cell held text (text shares the
   baseline); with icons in it the 2px reads as a wobble mid-row. Centring resolves
   the button in the 36px track the fields define, so the glyph lands on the numbers'
   optical centre. */
.item__classcell {
  grid-area: class;
  display: flex;
  align-self: center;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
/* same correction for the trailing cluster — it carried the same 2px lift, and
   fixing only the middle one would leave two icon groups at two heights */
.item__actions {
  grid-area: actions;
  align-self: center;
}
/* desktop: the wrapper is invisible to layout, so its children act as direct grid
   items in the shared columns. (on mobile it becomes a flex-wrap row — see below) */
.item__meta {
  display: contents;
}

/* the qty/amount label lives in the narrow 44px column; keep it on one line so a
   water row's volume ("1.75 L") never breaks between the number and its "L" unit. */
.item__cqty {
  white-space: nowrap;
}

/* packing / checklist — a big tap target */
.item--check {
  /* shared .item-row grid; packing feeds it a checkbox gutter + read cols, and centres
     the row on the checkbox instead of the baseline */
  --row-cols: var(--item-cols-pack);
  --row-align: center;
  --row-gap: var(--space-3);
  /* don't inherit the editable row's 5-area template — this element also carries .item,
     so it would pick up those areas and add phantom trailing gaps after the weight,
     pushing it in from the row's right edge */
  grid-template-areas: none;
  cursor: pointer;
  /* SAME inner height as the editable row (its name field is --field-h; the shared
     --space-2 wrapper padding is added identically on both), so toggling editing↔
     packing never changes a row's height. The whole row is the tap target, so
     --field-h (+ padding) is already a comfortable hit area — it earlier used
     field-h + 2×space-3, which stood 24px taller than the edit row and made the
     list jump on every toggle. */
  min-height: var(--field-h);
}
/* checkbox — drawn by the icon set now: Square (empty) under SquareCheck (checked),
   the same glyph as the header's packing toggle, stacked in one grid cell. The two
   share an identical outer square, so the checked icon fading in reads as the tick
   appearing inside the standing box. 20px — a step up from the old 18px drawn box;
   the icons pin their stroke at ~1.33px (absolute-stroke-width) so the bigger box
   keeps the same line weight the surrounding 16px icons render. */
.item__boxwrap {
  position: relative;
  align-self: center;
  width: 20px;
  height: 20px;
  flex: none;
  display: grid;
  place-content: center;
}
/* the real control, stretched over the icons: invisible (appearance:none draws nothing)
   but hoverable, clickable and focusable, so the native focus ring lands on the box */
.item__box {
  position: absolute;
  inset: 0;
  appearance: none;
  margin: 0;
  border-radius: 4px;
  cursor: pointer;
}
.item__boxicon {
  grid-area: 1 / 1;
  pointer-events: none;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.item__boxwrap:hover .item__boxicon {
  color: var(--ink);
}
/* the checked glyph pops in with the springy overshoot the old drawn tick had
   (SPACE10's easeOutBack); scale starts at .5 — not 0 — so its square lands on the
   standing one instead of visibly growing a second box */
.item__boxicon--check {
  opacity: 0;
  color: var(--ink);
  transform: scale(0.5);
  transition:
    transform var(--dur) var(--ease-spring),
    opacity calc(var(--dur) * 0.6) var(--ease);
}
.item__box:checked ~ .item__boxicon--empty {
  opacity: 0;
  transition: opacity calc(var(--dur) * 0.6) var(--ease);
}
.item__box:checked ~ .item__boxicon--check {
  opacity: 1;
  transform: scale(1);
}
.item__cname {
  min-width: 0;
}
/* a group (parent) in packing mode: name + trailing collapse chevron, like the
   editor row + folder header */
.item__cname--group {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
}
.item__cweight {
  text-align: right;
}
/* the common name in packing mode — a quiet upright sub-line under the product name,
   spanning from the name column (2) to the row end so it aligns under the name, not the
   checkbox; the negative tuck pulls it snug beneath, like the read row's sub-line */
.item__csub {
  grid-column: 2 / -1;
  /* same caption tuck as the read/edit rows (shared token) so the common name sits the
     same distance under the name in packing mode too */
  margin-top: var(--caption-tuck);
  color: var(--ink-2);
}
/* the unit suffix gap (.item__wunit) is shared with the read rows — atoms/item.scss */
/* packed = "in the bag", so it reads as done (dimmed), NOT excluded — the check
   mark carries the state; a strikethrough would say "removed/crossed off". */
.item--done {
  opacity: 0.5;
}

/* editable */
.item__qty,
.item__weight {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}
/* let the number input shrink so its unit suffix (L / lb) stays on the same line
   in the narrow columns instead of wrapping below */
.item__qty .field,
.item__weight .field {
  min-width: 0;
}
.item__unitwrap {
  position: relative;
  flex: none;
  display: inline-flex;
  /* centres the chevron ON the unit's text rather than letting it stretch. The wrap
     still contributes the unit's own baseline upward, so the number and its unit stay
     on one line with the rest of the row. */
  align-items: center;
}
.item__unit {
  flex: none;
}
/* The reserved chevron on water and group rows — present for layout, invisible to eyes
 * and to screen readers (aria-hidden at the call site). See the markup for why the slot
 * is held open by a real icon rather than by a width.
 *
 * `visibility: hidden`, not `opacity: 0`: opacity would leave it hoverable and would let
 * the row's :hover rule light a mark nobody can see. */
.item__unitchev--ghost {
  visibility: hidden;
}
/* The unit trigger's hit area. The bare glyph-and-caption is ~29×24, well under the
   44px target, and it was that small before too — the transparent <select> it replaced
   filled this same content-sized wrapper, so the small target predates the picker.
   --tap-pull is the row's own idiom (see .item__fixdismiss): grow the box to --tap on
   touch, then pull the overshoot back out of layout so the line keeps its rhythm.
   :deep() because the button lives inside OptionMenu — a class passed through a prop
   carries no scope id, which is the trap that dropped the total off its baseline. */
@media (pointer: coarse) {
  .item__unitwrap :deep(.optmenu__btn) {
    min-height: var(--tap);
    margin-block: var(--tap-pull);
  }
}
/* Quiet by default — one of these sits on every row, and a column of hard chevrons
   would shout louder than the weights they belong to. --ink-3 is the same step the
   row's other passive marks use; it lifts on hover so pointing at the row confirms
   the thing is live. */
.item__unitchev {
  flex: none;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
/* :has(), not a sibling combinator — the select is rendered AFTER the chevron, so
   `~` from it reaches nothing. Keyboard focus has to light the mark too, or the
   affordance exists for pointers only. */
.item:hover .item__unitchev,
.item__unitwrap:focus-within .item__unitchev {
  color: var(--ink-2);
}
/* transparent native select over the unit text — the same construction the total's
   unit picker uses. The label stays the only thing drawn; this just makes it a
   control. Sized to the label so it can't widen the weight column. */
/* the two classification toggles. Both --icon-btn wide, so the pair costs 68px of
   the 108–128px class track the old select needed for the word "Consumable" — the
   row gets denser, not busier. */
.item__cls {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
}
/* Water's fixed consumable mark, and its ghost worn slot: the toggle's exact box —
   .btn--icon's size, .item__mark's chip — minus the button, because there is
   nothing to press. Sized like the buttons so the two-slot cell holds its width
   on water rows and the cookie column runs unbroken through them. */
.item__clsfixed {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn);
  min-height: var(--icon-btn);
  border-radius: var(--radius-pill);
}
/* visibility, not opacity — the unit chevron's ghost rule: opacity would leave it
   hoverable, and a tooltip-less shirt lighting under a resting pointer reads as a
   control nobody can find again. */
.item__clsghost {
  visibility: hidden;
}
/* ON is a FILLED GROUND, not just darker ink — the shared `.item__mark` chip
   (atoms/item.scss), which the share views' rows draw as a static mark, so the two
   views can't drift on what "worn" looks like. Ink-vs-grey alone would be the same
   signal hover already uses, so a toggle would read as merely hovered.
   The OFF ink is scoped to the off state (`:not`) rather than stated flat: a scoped
   rule carries its component's attribute, so a flat `.item__clsbtn` would outrank
   the shared chip's own colour and leave a lit toggle drawn in --ink-3. */
.item__clsbtn:not(.item__mark) {
  color: var(--ink-3);
}
.item__clsbtn {
  border-radius: var(--radius-pill);
}
.item__clsbtn:hover {
  color: var(--ink);
}
@media (pointer: coarse) {
  /* the overshoot, as padding, so the chip's content box stays --icon-btn while the
     button stays --tap. box-sizing is border-box, so this costs the row no width.
     The fixed mark and its ghost grow the same way — not for a tap target they
     don't have, but so a water row's cell measures what every other row's does. */
  .item__clsbtn,
  .item__clsfixed {
    padding: calc((var(--tap) - var(--icon-btn)) / 2);
  }
}
/* anchored to the trigger, not the viewport: the point of the popover is that it
   opens where you were already looking. Right-aligned so it can't push the row's
   action cluster off a narrow screen. */
/* ONE popover recipe, worn and consumable both. They hold the same shape — a switch
   row, then that class's detail — so they share the surface rather than drifting. */
.item__pop {
  /* The popover's own padding, and the basis for its inner corners. --popover-item-radius
     (controls.scss) assumes --space-2 of padding; this surface uses more, so it re-derives
     the inner radius from its OWN padding rather than inheriting a value that would leave
     the field's corners rounder than the gap around them. */
  --pop-pad: var(--space-3);
  --pop-inner-radius: calc(var(--radius-4) - var(--pop-pad));

  position: absolute;
  top: calc(100% + var(--space-1));
  right: 0;
  z-index: var(--z-menu);
  display: grid;
  gap: var(--space-2);
  padding: var(--pop-pad);
  /* one width for both popovers, set by the longest switch row ("Consumable" + the
     switch) so the two read as the same object rather than two sizes of card. Wide
     enough that neither detail label wraps — a wrapped label is what made these look
     like two different components. */
  width: 13rem;
}
/* flipped when the row sits too close to the viewport floor (see togglePop) */
.item__pop.is-above {
  top: auto;
  bottom: calc(100% + var(--space-1));
}
/* Every line in the popover starts on the card's padding edge — the switch row, the
   labels, the field's box and the derived line all share it. An earlier version
   inset the labels to meet the field's TEXT, which was wrong twice over: the field's
   number is right-aligned so there is no left text edge to meet, and the field's BOX
   is the dominant vertical line, so indenting past it just read as two ragged edges. */
.item__poplabel {
  margin: 0;
  line-height: 1;
  white-space: nowrap;
}
/* the split counts — a row of small quiet buttons, the active one lit like the
   toggles above it, so "which" is answered by the same signal as "whether" */
.item__splits {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.item__split {
  min-width: var(--icon-btn);
  min-height: var(--icon-btn);
  padding-inline: var(--space-2);
  justify-content: center;
  border-radius: var(--pop-inner-radius);
  background: var(--paper-2);
  color: var(--ink-2);
}
.item__split:hover {
  background: var(--paper-3);
  color: var(--ink);
}
/* the chosen count takes the same quiet-grey chip as an active row toggle, one step
   deeper — the popover's own ground is already --paper-2, so the resting chip has to
   sit above it to read as a button at all */
.item__split.is-active,
.item__split.is-active:hover {
  background: var(--ink);
  color: var(--paper);
}
/* .field is deliberately borderless — it lives in the row grid, where a box per cell
   would be pure noise. On a floating surface that reasoning inverts: with nothing
   around it the number reads as printed text, not as something you can type into.
   So the field declares itself here, and only here.
   A FILL rather than a border does it: --surface-float is the brightest tone on the
   page, so a well sunk into it reads as "type here" at a glance, where a hairline
   rectangle has to be looked at to be seen. */
.item__popinput {
  width: 100%;
  min-height: var(--icon-btn);
  padding: var(--space-1) var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--pop-inner-radius);
  background: var(--paper-2);
}
/* focus deepens the well and rings it — the caret alone is too quiet once the field
   has a ground of its own to sit on */
.item__popinput:focus {
  background: var(--paper-3);
  border-color: var(--line-2);
}
.item__popline {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
}
.item__poplineicon {
  flex: none;
  color: var(--ink-3);
}
/* row controls (note + remove) stay visible at rest; the note button is lit when
   a note exists, and hover just darkens for feedback */
.item__actions {
  display: flex;
  align-items: center;
  justify-self: end;
  gap: var(--space-1);
}
/* right-align all three glyphs (note · remove · grip) in their tap targets so they
   read as evenly spaced with the grip flush to the edge — centering note/remove
   while the grip sat hard-right left an uneven, wider gap before the grip */
.item__actions .btn--icon {
  justify-content: flex-end;
}
.item__grip,
.item__note-btn,
.item__nest-btn,
.item__vault-btn,
.item__del,
/* the ⋯ overflow (mobile) — override .menu__btn's --ink-2 so it reads at the same
   weight as the delete + grip it sits between */
.item__morebtn {
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.item__note-btn.is-active {
  color: var(--ink-2);
}
.item__grip:hover,
.item__note-btn:hover,
.item__nest-btn:hover,
.item__vault-btn:hover,
.item__del:hover,
.item__morebtn:hover {
  color: var(--ink);
}
/* banked: the tick holds at full ink so the row keeps saying so, the same way the
   note button stays lit once a note exists */
.item__vault-btn.is-active,
.item__vault-btn.is-active:hover {
  color: var(--ink);
}
.item__vault-btn:disabled {
  cursor: default;
}
/* The save button's coming and going is STATE — the automatic capture releasing a
   row, or taking it. Arrival gets a little sizzle: the trigger pops in, and a
   light front sweeps left-to-right through the glyph — a soft-edged mask wipe
   over the icon held at full ink, whose final frame is the no-mask state, so the
   sweep ends where rest begins. When the enter class lifts, the button's own
   color transition (above) settles the lit glyph onto --ink-3 — the SAME token
   every other icon in the cluster rests at, so a settled row reads as one even
   set, not a set with one recently-excited member.
   Leave is a quick quiet fade: the moment belongs to arrival.
   Everything here is CSS — keyframes, mask, timing; the <Transition> wrapper only
   gates the standard enter/leave classes, the same idiom as the row's menus. And
   no `appear`: a fresh row (or page) animates nothing; the shine plays only when
   an EXISTING row's button comes back, which is the beat that means something
   ("you can save this now").
   One duration for both animations, keyed off the ROOT: Vue times the transition
   from the root element's animation, so a longer sweep on the inner svg would be
   cut off mid-shine when the class comes off. The pop instead lands early inside
   the shared window and holds; the sweep starts a beat later (delay +
   fill backwards) so it runs through a glyph that has already landed. (The global
   reduced-motion rule in main.scss flattens all of it.) */
.vaultin-enter-active {
  animation: vault-pop calc(var(--dur) * 3) var(--ease);
}
.vaultin-enter-active .item__vault-btn {
  color: var(--ink);
}
.vaultin-enter-active .item__vault-btn svg {
  mask-image: linear-gradient(100deg, #000 45%, rgba(0, 0, 0, 0) 65%);
  mask-size: 250% 100%;
  mask-repeat: no-repeat;
  animation: vault-shine calc(var(--dur) * 2.25) var(--ease) calc(var(--dur) * 0.75) backwards;
}
@keyframes vault-pop {
  0% {
    opacity: 0;
    transform: scale(0.5);
  }
  35% {
    opacity: 1;
    transform: scale(1.08);
  }
  60%,
  100% {
    transform: scale(1);
  }
}
@keyframes vault-shine {
  from {
    mask-position: 100% 0;
  }
  to {
    mask-position: 0% 0;
  }
}
.vaultin-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.vaultin-leave-to {
  opacity: 0;
  transform: scale(0.5);
}
/* drag-to-reorder */
.item-wrap {
  position: relative;
}
/* picked up: the whole row lifts off the page, follows the pointer (--drag-dy is
   updated live by useItemDnd), and casts a shadow so it reads as a held object.
   pointer-events:none so the drop detection (elementFromPoint) sees the rows
   underneath, not the floating row. */
.item-wrap.is-dragging {
  position: relative;
  z-index: var(--z-lifted);
  pointer-events: none;
  transform: translateY(var(--drag-dy, 0)) scale(1.01);
  /* a raised surface tone (not the page colour) so the lifted row reads as
     elevated in BOTH themes without a glow — dark gets a visible dark-grey card */
  background: var(--paper-2);
  border-radius: var(--radius-2);
  /* a hairline ring (subtle in BOTH themes — no white glow in dark, which the
     old --ink-derived shadow caused) + the shared floating-surface drop (--shadow-pop,
     also used by the toast) so the two lifted surfaces read at one height */
  box-shadow:
    0 0 0 1px var(--line-2),
    var(--shadow-pop);
  cursor: grabbing;
}
/* insertion line marking where the dragged row will land */
.item-wrap.is-drop-before::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--space-px);
  background: var(--ink);
  pointer-events: none;
}
/* "will nest under this row" — a left thread bar + faint tint on the target parent,
   the only cue when nesting under a row that has no children yet (and so no group
   tail line to light up). Mirrors the nested block's own left thread line. */
.item-wrap.is-nest-parent > .item {
  box-shadow: inset 2px 0 0 var(--ink);
  background: var(--paper-2);
  border-radius: var(--radius-1);
}
/* grip is the last icon in the trailing actions cluster (note · remove · grip);
   sizing/colour come from .btn--icon / the shared colour rule above */
.item__grip {
  cursor: grab;
  touch-action: none;
  /* the reorder dots sit flush to the row's right edge — the visible glyph, not
     just the 44px tap target: right-align the icon in its (still-full-size) button,
     then shift out the glyph's own internal right-padding (the dots end ~⅓ in from
     the viewBox edge). The empty overshoot falls into the page's right gutter. */
  justify-content: flex-end;
  /* the dots stay flush (right edge pinned by justify-self:end on the cluster), but
     this pulls the grip's LAYOUT box left so the gap before it matches note→remove —
     the flush shift is otherwise invisible to layout, leaving a wider gap here. */
  margin-left: -9px;
}
.item__grip svg {
  transform: translateX(33.333%);
}
.item__grip:active {
  cursor: grabbing;
}

/* The row's controls used to hide at rest on desktop and fade in on hover, to keep a
   long list quiet. That reads as an empty row until you point at it: the actions are
   undiscoverable, and the row's right half visibly re-populates under the cursor as
   as you scan down the list. A row that simply shows its controls has no flicker to
   have.
   They are ghosted (--ink-3) at rest and darken on hover instead, so the row is calm
   without being blank. Nothing here is opacity-animated any more, which also retires
   the Safari layer-snap workaround the old rule needed. */

/* the .reveal recipe now lives in atoms/controls.scss — three surfaces disclose the
   same way, and while it was scoped here the other two got the class names with none
   of the transition. Only this row's own VARIANT stays local. */
.reveal-enter-from,
.reveal-leave-to {
  --reveal-offset: 0;
}
.reveal-enter-from > *,
.reveal-leave-to > * {
  transform: translateY(0.4em);
}
/* the editing↔packing row swap lives in atoms/item.scss now — it keys off the editor
   body's data-mode, which no scoped block can see, and the fade that used to be a
   <Transition> here is the rowmode-fade animation there. */
/* the note tucks up under the name (into the 36px field's dead space); the offset
   lives on the wrapper, not the input, so the grid track sizing stays clean.
   Cancelling that dead space puts the caption's line box flush under the name's — the
   distance the read/share row matches with its 0 row-gap (ReadonlyItemRow .item--ro). */
.reveal--note {
  --reveal-offset: var(--caption-tuck);
}
/* the two sub-line fields (common name + note) stack as one grid child so the reveal's
   1fr↔0fr slide keeps a single clipping child; a hair of gap keeps the two lines apart */
.item__subfields {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* the common-name field is an upright quiet LABEL (--ink-2), distinct from the note's
   italic aside voice below it — mirrors the read-only sub-line's two voices. .item__note
   also matches this element and sets italic, so pin the override at higher specificity to
   win regardless of source order. */
.item__note.item__gtype-input {
  color: var(--ink-2);
  font-style: normal;
}
/* note — a single-line live-text field under the item (no box, no resize handle).
   reads as a caption: the lightest ink (matching the "Add an item" placeholder) and
   italic, to sit quietly beneath the item name. */
.item__note {
  width: 100%;
  min-height: 0;
  /* the upward tuck under the name now lives on the .reveal--note wrapper (so the
     grid track sizing stays clean); this element just fills its cell */
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-3);
  font-size: 1rem; /* static 16px — avoid iOS focus-zoom (see .field in controls.scss) */
  font-style: italic;
}
.item__note::placeholder {
  color: var(--ink-3);
}
/* the note keeps its quiet entered colour (--ink-3) while you type it too — no
   contrast jump between editing and resting (stays italic) */
.item__note:focus {
  outline: none;
}
/* quiet "suggest a fix" link under a row */
.item__under-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-1);
  padding: 0;
  background: none;
  border: 0;
  color: var(--ink-3);
  text-align: left;
  cursor: pointer;
}
.item__under-link:hover {
  color: var(--ink);
}
/* the suggest-a-fix nudge + an × to dismiss it from the page */
.item__fixrow {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-1);
}
.item__fixrow .item__under-link {
  margin-top: 0;
}
/* composes .btn--icon for the real tap target (--icon-btn box, --tap on touch) —
   without it the bare 14px glyph was the whole hit area. This rule keeps the quiet
   --ink-3 treatment over .btn--ghost's ink, and the negative block margins pull the
   enlarged box back out of layout so the fix row keeps its one-text-line rhythm
   (the actions cluster's overshoot technique). */
.item__fixdismiss {
  color: var(--ink-3);
  margin-block: var(--tap-pull);
}
.item__fixdismiss:hover {
  color: var(--ink);
}

/* the nested block's thread-line container is the shared .nest-block atom
   (atoms/item.scss), rendered identically by ReadonlyItemRow */
/* the collapse machinery (1fr↔0fr grid slide + clip) is the shared .nestcollapse atom
   (atoms/item.scss). The editor's only addition: lift the clip while a child overlay
   is open or a drag is live, so a child's autocomplete dropdown / lifted row isn't
   cropped (mirrors the folder's is-overlay-open / is-dragpass lifts). */
.nestcollapse.is-lifted > .nest-block {
  overflow: visible;
}
/* drag-to-reorder: insertion line when a nested sibling drops at the end of this
   group (the folder's tail line stands down for it — see FolderSection) */
.item-nest__droptail {
  height: var(--space-px);
  background: var(--ink);
  margin: var(--space-1) 0;
}
/* ever-present "Add an item" at the bottom of a group, so growing a group needs no hover.
   It sits inside the thread line with the rest of the nested block; no horizontal rule.
   Its look IS the folder add row's — one shared add-affordance atom (atoms/item.scss),
   including the mobile compaction. */

/* the ⋯ overflow menu is mobile-only — desktop shows every action inline (below) */
.item__more {
  display: none;
}

@media (max-width: $bp-stack) {
  /* the full-width name gets its own line so long product names never truncate;
     qty · weight · class + the controls reflow into a flex-wrap row beneath it,
     and the controls drop to a further line if that row runs out of width.
     :not(.item--check) because the checklist rows share the wrapper now — they
     keep their own grid below. */
  .item-wrap .item:not(.item--check) {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    /* the name + its meta line read as one unit — keep them close (space-2 felt
       like two separate rows) */
    gap: var(--space-1);
  }
  .item__name {
    width: 100%;
  }
  /* The nested block's own inset (--space-4 of margin + --space-4 of padding either
     side of the thread line, .nest-block in atoms/item.scss) is most of what says
     "one level down"; this only tunes the outer half.
     It used to add --space-5, on the reasoning that a child should hang under the
     parent's WEIGHT rather than mid-name — but the mobile row has no weight COLUMN to
     hang from (the field is field-sizing: content, so it starts at a different x on
     every row), so that was aiming at a mark which isn't there, and it left a phone
     MORE indented than a desktop, 41px against 33px, on the screen with the least
     width to spare. A step down to --space-3 reads as the same nesting — the thread
     line and its padding are the signal, and the child's name still clears the
     parent's — and hands the 12px back to the child's own row, which is the row on
     the page that runs out of width first. */
  .item-nest {
    margin-left: var(--space-3);
  }
  /* tighter text boxes so the name and its meta line sit close as one unit — the
     default 36px field min-height, with vertically-centred text, left a big visual
     gap between the two lines. (:deep reaches the name input inside <ItemInput>.) */
  .item-wrap .item .field,
  .item-wrap .item__name :deep(.field) {
    min-height: 0;
    padding-block: 2px;
    line-height: 1.3;
  }
  /* The caption sits under the META line here rather than under the name field, so
     the desktop tuck (sized for a 36px field's dead space) is the wrong correction:
     there is no dead space left to cancel. Every touch box on this line is pulled back
     onto it (see .item__classcell / .item__actions below), so the meta row is now as
     tall as its TEXT — a 24.8px field box — and its bottom edge already sits directly
     under the "2 × 540 g" the caption belongs to. So this is a GAP, not a tuck — and
     it's the row's own gap: --space-1 is what .item already puts between the name and
     the meta line, and what .item__subfields puts between the gear type and the note.
     Three text lines, one rhythm. (Zero is wrong for the same reason a tuck is: with
     no margin the caption's line sits 8.4px under the meta's against the 12.8px above
     it, and that third line reads as belonging to the row below.) Still routed through
     this hook, so the offset retires with the height on close.
     It used to pull back by half the button overhang, which is what that dead space
     measured while the classification toggles stood 44px tall in a 25px line. */
  .reveal--note {
    --reveal-offset: var(--space-1);
  }
  /* one line only — qty · weight · class on the left, controls on the right — so a
     row is never more than two lines (name + this) and icons never land on a third */
  .item__meta {
    display: flex;
    flex-wrap: nowrap;
    align-items: baseline;
    /* Generous gap BETWEEN the groups (qty · weight · class) so they read as
       distinct — each number stays tight to its own ×/unit (see .item__qty gap +
       the 1ch field min-width); this is the separation between those pairs.
       It SHRINKS on the narrowest screens rather than holding at space-4 and
       overflowing. Once the classification cell became two toggles, a coarse
       pointer's --tap sizing left this line needing more width than a 375px phone
       has, and a fixed gap spends on air the controls need. Above ~640px it
       resolves to space-4 and nothing changes. */
    gap: clamp(var(--space-2), 2vw, var(--space-4));
  }
  /* right-anchored, but by the classification cell's auto margin rather than its own
     — see .item__classcell below, which is what pushes this pair of clusters right */
  .item__actions {
    flex: none;
    align-self: center;
  }
  /* the --tap tap targets keep their size but overflow the (shorter) text line via
     negative margins, so the icons don't inflate the row and push the two text
     lines apart.
     BOTH icon groups on this line, not just the trailing one. The classification cell
     held a text label when this rule was written; once it became two --tap buttons it
     stood 44px tall inside a ~25px text line, and the flex line grew to fit it. The
     numbers are baseline-aligned so they stayed at the top of that taller line while
     everything centred in it — the toggles AND the trailing icons — sank ~10px below
     them. Pulling the toggles back onto the line is what lands every glyph on the
     numbers' optical centre, and it gives back the editing↔packing height parity
     .item--check is built around: the inflated line made an edit row 19px taller than
     the checklist row it toggles into, so the list jumped on every mode switch. */
  .item__actions .btn--icon,
  .item__classcell .btn--icon,
  .item__classcell .item__clsfixed {
    min-height: 0;
    height: var(--tap);
    margin-block: var(--tap-pull);
  }
  /* mobile trailing cluster = ⋯ · grip. Everything else the row can do — the note, the
     nesting actions, the vault save and the removal — moves into the ⋯ menu, which
     names each one in words rather than asking a 16px glyph to.
     It is width that decides how many stay: on a coarse pointer every .btn--icon grows
     to --tap, so each inline icon costs 48px of a line that also has to carry the qty,
     the weight and the two classification toggles. Delete was the last one held back —
     and it was the difference between a row that fits and a row that doesn't. Keeping
     it inline, a NESTED row (indented --space-5) needed ~421px of viewport for a
     four-figure weight, so "1 × 1,588 g" one level down ran its grip off the side of
     every iPhone but the largest; at 375 even a top-level six-figure weight went ~15px
     over. Two icons is what the line can hold, and the drag grip and the menu that
     carries everything else are the two that have to be reachable.
     Hide each departed one's BOX, not just the button in it. Three of them sit inside a
     <Tooltip>, which renders a .tooltip-trigger wrapper, and the nesting menu has its
     own .menu div — hiding only the button leaves those wrappers as zero-width flex
     items, and a zero-width flex item still takes its share of the cluster's gap. That
     was four phantom 4px gaps inside a cluster whose visible content is two buttons,
     and the nesting one is CONDITIONAL (a group row offers no nest action), so the
     cluster came out 4px narrower on group rows than on the rest — enough to knock
     those rows out of the column the classification cell now rides. :has() is what
     reaches a wrapper from the hidden button inside it; the alternative is a class per
     Tooltip, which is markup spent on saying what the button already says. */
  .item__nest,
  .item__actions .tooltip-trigger:has(.item__note-btn),
  .item__actions .tooltip-trigger:has(.item__vault-btn),
  .item__actions .tooltip-trigger:has(.item__del) {
    display: none;
  }
  .item__more {
    display: inline-flex;
  }
  /* the classification cell used to hold a text label that had to ellipsize to keep
     qty/weight/controls on one line. Two icon toggles are a fixed 68px, so there is
     nothing left to shrink — it just holds its size beside the other controls.
     THE AUTO MARGIN LIVES HERE, not on .item__actions. The weight field is
     field-sizing: content, so anything that simply follows it starts at a different x
     on every row: "--" vs "12,250" swung these two toggles ~39px down a list while the
     right-anchored actions held still, so the tap targets you reach for most never
     formed a column. Pushing the cell right instead parks it against the actions —
     both clusters then ride the row's right edge, on every row, and the desktop grid's
     fixed class track (tokens.scss) gets its mobile equivalent. It costs no width: the
     free space it eats is the slack the widest row in the list doesn't have anyway.
     It must be the ONLY auto margin on the line — a second one splits the free space
     between them and the drift comes straight back at half size. (The ≤360px coarse
     block re-declares it on .item__actions because there the cluster wraps onto a line
     of its own, where the two margins can't meet.) */
  .item__classcell {
    flex: none;
    margin-left: auto;
  }
  /* the number fields have no grid column to fill on mobile, so give them compact
     explicit widths — otherwise width:100% balloons to the default text-input size
     and each control wraps onto its own line */
  .item__qty,
  .item__weight {
    flex: none;
  }
  /* flush-left on the flowing mobile row — the global right-align is for the desktop
     columns; here it would indent a short value (e.g. "1") from the viewport edge */
  .item__qty .field,
  .item__weight .field {
    text-align: left;
  }
  .item__qty .field {
    width: 2.5em;
  }
  .item__weight .field {
    width: 4em;
  }
  /* where supported, size the number fields to their value so "1 ×" / "321 g" read
     as tight pairs instead of sitting in over-wide boxes (widths above = fallback).
     min-width 1ch: just enough for a single digit + the caret — 2ch left a full
     empty character between a one-digit value and its × / unit on mobile. */
  @supports (field-sizing: content) {
    .item__qty .field,
    .item__weight .field {
      width: auto;
      field-sizing: content;
      min-width: 1ch;
      /* A hair of slack, and it is not cosmetic: `field-sizing: content` sizes the box
         to the text's measured width, which rounds DOWN against the glyphs actually
         rasterised — so the last character loses a sliver and "0.68" renders as "0.6⌐".
         Measured at 375px: several fields sat at clientWidth 14 against scrollWidth 15,
         i.e. exactly one pixel short. 1px each side buys the rounding back without
         moving anything perceptibly, and without a min-width big enough to reintroduce
         the over-wide boxes this block exists to remove. */
      padding-inline: 1px;
    }
    /* `field-sizing: content` measures the VALUE, and an empty field has none — so it
       falls back to min-width while still drawing a two-character "--", which then
       clips. Only the empty state needs the room, so only the empty state is given it:
       a filled field keeps sizing to its own digits, which is what stops one-digit
       values sitting in an over-wide box. */
    .item__qty .field:placeholder-shown,
    .item__weight .field:placeholder-shown {
      min-width: 2.4ch;
    }
  }

  /* checklist: the checkbox sits to the LEFT of the name (conventional checklist),
     in its own column spanning both text lines; the name is on its own line with
     ×qty · weight below. The two text lines keep the editing row's metrics (36px
     each) so toggling between editing and packing modes never reflows the row. */
  .item--check {
    /* stack via the shared .item-row grid: a checkbox column, then the name (row 1)
       over ×qty · weight (row 2) — cell placements below. --row-align stays `center`
       from the desktop rule; only the columns + gap change here. */
    --row-cols: auto auto 1fr;
    --row-gap: var(--space-1) var(--space-3); /* row-gap · column-gap */
    min-height: 0; /* drop the desktop tall single-row min-height */
  }
  /* checkbox in the left column, aligned to the title line (not centred across the
     whole two-line cell) — it sits beside the name, centred to that first row */
  .item__box {
    grid-column: 1;
    grid-row: 1;
    align-self: center;
  }
  /* same box metrics as the editing fields (padding + line-height) so a checklist
     row is the exact same height as its editing counterpart — no shift on toggle */
  .item__cname {
    grid-column: 2 / -1;
    grid-row: 1;
    padding-block: 2px;
    line-height: 1.3;
    display: flex;
    align-items: center;
  }
  .item__cqty {
    grid-column: 2;
    grid-row: 2;
  }
  /* the qty/weight cells' compact box metrics are shared with the read rows —
     atoms/item.scss */
  .item__cweight {
    grid-column: 3;
    grid-row: 2;
    justify-self: start;
    text-align: left;
  }
  /* common name on its own third line (under name + qty/weight), aligned to the name
     column; the row-gap gives the spacing so drop the desktop upward tuck */
  .item__csub {
    grid-column: 2 / -1;
    grid-row: 3;
    margin-top: 0;
  }
}

/* The narrowest phones (iPhone SE and friends), and ONLY on a touch pointer.
 *
 * The meta line is nowrap by design — two lines per row, never three. That holds at
 * 375 with room to spare, but it cannot hold at 320 once .btn--icon grows to --tap:
 * the line then wants 323px inside a 288px content box, and the trailing grip ends up
 * ~19px past the screen. Measured, not guessed.
 *
 * Two 44px toggles (92px) and three 44px actions (143px) are most of that, and none of
 * it is padding to reclaim — shrinking either is exactly the touch target the coarse
 * query exists to protect. So the line is allowed to wrap here, and the actions
 * cluster drops beneath the numbers rather than off the edge of the phone. A third
 * line on a 320px screen is a worse row than two; an unreachable delete button is not
 * a row at all.
 *
 * pointer: coarse is part of the condition on purpose — a 320px-wide DESKTOP window
 * keeps 32px icons, still fits on one line, and should not be given the phone layout.
 */
@media (max-width: 360px) and (pointer: coarse) {
  .item__meta {
    flex-wrap: wrap;
    row-gap: var(--space-1);
    /* Right-aligns the actions once they drop to a line of their own — there is no
       classification cell down there to carry the auto margin that does it everywhere
       else (.item__classcell, above).
       justify-content rather than a second margin-left:auto, because not every row
       wraps at this width: a short one still fits on one line, and there two auto
       margins would SPLIT the free space between them and put back half the drift this
       whole block is meant to remove. justify-content can't do that — an auto margin
       consumes the free space before it is consulted, so it stays inert on any line
       that has one and takes charge only on the line that doesn't. */
    justify-content: flex-end;
  }
}
</style>
