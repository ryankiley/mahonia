<script lang="ts">
import type { InjectionKey, Ref } from "vue";
import type { Classification, Item as ItemT, Person, Unit } from "~~/shared/types";

// What GearEditor derives ONCE per snapshot for every row, reached by inject rather
// than threaded down as props. Props would carry the same one-pass tables — but a
// prop that is a fresh Map per recompute re-renders every row it passes through on
// every structural edit, folders and leaves alike, to hand most of them a value
// they don't read. Injected, a row subscribes to the table only where it looks
// something up, and the rest stay skipped.
//  • children grouped by parent id — one groupItemsByParent pass, so a parent row
//    doesn't re-scan the whole item array for its children on every render
//  • the people in display order, and each person's SLOT (their index in that
//    order) — the row's filter attribute and its picker both read these, and
//    every row was sorting the people list for itself
export const CHILDREN_BY_PARENT: InjectionKey<Readonly<Ref<Map<string, ItemT[]>>>> =
  Symbol("childrenByParent");
export const PEOPLE_CTX: InjectionKey<{
  sorted: Readonly<Ref<Person[]>>;
  slotById: Readonly<Ref<Map<string, number>>>;
}> = Symbol("people");

// static per-component tables — module scope so a large list doesn't rebuild
// them in every row instance
const STEP_BY_UNIT: Record<Unit, number> = { g: 1, kg: 0.01, oz: 0.1, lb: 0.1 };
// one stable empty array for every leaf row, so `children` never mints a fresh
// identity per row per render
const NO_ITEMS: ItemT[] = [];
// Per-item nest-collapse: usePersistedCollapse's module-level cache, keyed
// gear.nest.<id> — one blocking storage read per row per remount was the cost this
// cache retired (its header carries the reasoning and the cross-tab invalidation).
const nestCollapse = usePersistedCollapse("gear.nest.");
// offered "N worn" split counts stop here (the stored value is always shown even
// beyond the cap, so clamps/imports can't strand invisible state)
const MAX_SPLIT_OPTS = 5;
// The count's own bounds — at least one of something, and no more than the reducer
// will store (cleanItemPatch caps at 9999, shared/ops). Both ways in go through the
// same clamp, so the stepper and the typed field can't disagree about the ceiling,
// and neither can hand the store a number it would silently rewrite underneath them.
const QTY_MAX = 9999;
const clampQty = (n: number) => Math.max(1, Math.min(QTY_MAX, Math.round(n)));
// the four units as OptionMenu rows — WEIGHT_UNIT_OPTIONS (app/utils/unitOptions),
// the same list the totals' unit picker draws from
</script>

<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { CalculateIcon, Cancel01Icon, CheckIcon, CheckmarkSquare02Icon, ChevronDownIcon, CircleEllipsisIcon, CookieIcon, Delete02Icon, DropletIcon, GripVerticalIcon, ListIndentIncreaseIcon, MinusSignIcon, PlusSignIcon, SafeBoxIcon, ShirtIcon, SquareIcon, UserIcon } from "@hugeicons/core-free-icons";
import type { Item, ListSnapshot } from "~~/shared/types";
import type { ItemPatch } from "~~/shared/ops";
import { effectivePersonId, personColor } from "~~/shared/people";
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
    // (children grouped by parent id, and the people tables, arrive by inject —
    // see CHILDREN_BY_PARENT / PEOPLE_CTX above)
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
    // the parent row's EFFECTIVE person, for a nested row to fall back to (the
    // parent renders its own children, so the one-level inherit rule needs no
    // global lookup). Fine as a prop where the filter itself isn't: it changes
    // only when an assignment changes — which re-renders that group anyway —
    // never on a filter flip.
    inheritedPersonId?: string;
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
const { hasVault, vaultKnown } = useVaultAccess();
// ...and the one fact neither of those carries: what My Gear actually holds, and
// at what weight. Read from a shared singleton, so a 150-row list asks once
// (useVaultKeys).
const { vaultGear, vaultKeysKnown } = useVaultKeys();

// The two mount latches (each row face mounts the first time its mode is entered and
// then stays, CSS-hidden elsewhere) and the mode itself, for event handlers only —
// neither `mode` nor anything else here changes per switch in a way this row renders.
const { mode: editorMode, everEdit, everPacked } = useEditorMode();

// ---- nesting: children render as the SAME row, indented under this one ----
// A row with children is a "group": its weight column shows the group total (own +
// children, read-only, like a folder subtotal); the children carry the real editable
// weights. Nesting is one level, so a nested row never renders its own children.
const childrenByParent = inject(CHILDREN_BY_PARENT)!;
const children = computed(() =>
  props.nested ? NO_ITEMS : (childrenByParent.value.get(props.item.id) ?? NO_ITEMS),
);
const isParent = computed(() => children.value.length > 0);
// collapse a nested group — hide/show its children, persisted per item id (pure UI
// state, never sent to the server), mirroring the folder collapse. Only meaningful on
// a parent row; packing mode always shows children (you're checking them off).
const nestCollapsed = ref(false);
// Still adopted on MOUNT rather than at setup, so the first paint is unchanged — this
// only swaps where the value comes from (see nestCollapse above).
onMounted(() => {
  nestCollapsed.value = nestCollapse.isCollapsed(props.item.id);
});
function toggleNest() {
  nestCollapsed.value = !nestCollapsed.value;
  nestCollapse.set(props.item.id, nestCollapsed.value);
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
  nameEditing.value = false; // done with this row — the untouched empty sub-fields fold away
  c.discardEmpty(props.item.id);
}

/**
 * Commit whatever number field is being edited before a control in this row acts on it.
 *
 * Every button in the row prevents its own mousedown default — see the actions cluster's
 * comment in the template for why (a click out of a focused field would otherwise blur
 * the row, and discardEmpty would take a pristine one out from under the click). What
 * that costs is the blur, and the blur is what fires `change` — which is where onQty and
 * onWeight commit. So a number you typed and then acted on WITHOUT leaving the field was
 * never stored: the toggle re-rendered the row, the field repainted from a state that had
 * never heard about it, and the number you had just typed was simply gone. Reported as
 * the amount or the weight disappearing when a row is made consumable, which is the
 * shortest path to it — type a weight, tap the cookie, watch it empty itself — but every
 * mousedown-prevented control in the row had the same hole, worn and the ⋯ menu included.
 *
 * Dispatching the field's own `change` runs the exact commit the blur would have run, and
 * both handlers resync from state afterwards, so the later real blur re-firing it is a
 * no-op. Focus stays where it was, which is the whole point of the prevent.
 *
 * ON CLICK, CAPTURE — not pointerdown, which is where this started. Committing that early
 * re-lays the row out mid-gesture: clearing a weight drops the row below vaultWorthy, the
 * vault icon leaves the actions cluster, every cell shifts, and the button the finger was
 * on is no longer under it at mouseup — so the tap that triggered the commit then landed
 * on nothing and the popover never opened. By click the gesture has already resolved.
 * Capture so this still runs BEFORE the control's own handler; Vue patches the DOM on the
 * microtask, so nothing has moved by the time that handler runs.
 *
 * NUMBER FIELDS ONLY (.field--num — qty, weight, and the popovers' kcal). The name field
 * commits through the autocomplete's own path (NameCommit), and firing a bare `change`
 * underneath that would be a second, blinder way to commit a catalog pick.
 */
function flushPendingEdit(e: Event) {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement)) return;
  // still editing this very field — a resync mid-edit would collapse the caret to the
  // end, so pressing INTO the field you are already in must change nothing
  if (active === e.target) return;
  if (!active.classList.contains("field--num")) return;
  if (!wrapRef.value?.contains(active)) return; // another row's field is that row's business
  active.dispatchEvent(new Event("change", { bubbles: true }));
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
  const q = clampQty(Number(el.value) || 1);
  c.updateItem(props.item.id, { qty: q });
  el.value = String(q); // resync even when the clamp is a no-op (e.g. 0 / letters)
}
// The number pops when the stepper moves it — the SAME motion the big total takes
// when it changes (the shared `num-pop` keyframe, main.scss; AnimatedCount runs it
// per character up there). Not that component: this figure is an <input>, so it has
// no per-character spans to stagger, and at one or two digits a cascade wouldn't
// read anyway. The element takes the pop whole.
//
// A CSS animation has to be RESTARTED rather than re-fired — a class that never left
// never replays — so: drop it, force a reflow, put it back. The same three steps
// AnimatedCount takes, for the same reason.
const qtyFieldRef = useTemplateRef<HTMLInputElement>("qtyFieldRef");
const qtyPopping = ref(false);
function popQty() {
  qtyPopping.value = false;
  nextTick(() => {
    void qtyFieldRef.value?.offsetHeight;
    qtyPopping.value = true;
  });
}
// The stepper: ±1, which is what nearly every change to a count actually is.
// Clamped rather than guarded on the disabled attribute alone — qty can move under
// the buttons (an undo, another device's edit landing), so the floor and ceiling
// have to hold at the moment of the press, not at the moment of the render. A press
// at either end is then a no-op instead of a commit the reducer would rewrite — and
// nothing pops, because nothing moved.
function stepQty(dir: 1 | -1) {
  const next = clampQty(props.item.qty + dir);
  if (next === props.item.qty) return;
  c.updateItem(props.item.id, { qty: next });
  popQty();
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
    // the catalog's cited calories pre-fill like the vault's do: a food pick IS
    // the product, so its kcal comes along with its weight; absent (any non-food
    // row) leaves whatever the row already says, same as the vault branch
    if (p.kcal != null) patch.kcal = p.kcal;
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

// the sub-line: the gear type (common name) and the note. Each shows as an editable
// field whenever it holds a value (a catalog pick pre-fills the gear type), and both
// empty fields appear while the product name is being edited, so a row typed by hand
// has a visible place to put either — there is no separate "add a note" control. Each
// is cleared by emptying its own input.
const cnameRef = useTemplateRef<HTMLInputElement>("cnameRef");
const noteRef = useTemplateRef<HTMLInputElement>("noteRef");
// Set by focus landing anywhere in the name cell; held until focus leaves the ROW (so
// tabbing on to the fields themselves, or to qty/weight, doesn't yank them away
// mid-edit), then cleared by onRowBlur. An empty field just folds back up — nothing is
// written by revealing it.
const nameEditing = ref(false);
// A GROUP's own name is already the everyday label — that's where it comes from
// (useGearList.containerFor lifts the wrapped product's common name up to be the
// group's name), so offering a group a second one is circular. A parent therefore
// never opens the EMPTY field. A value it already carries still shows, so a row
// that acquired one before it became a group can still be read and cleared —
// never a stored value with no field to edit it.
const cnameShown = computed(() => !!props.item.commonName || (nameEditing.value && !isParent.value));
const noteShown = computed(() => !!props.item.description || nameEditing.value);
// the sub-line block shows when either field does
const subShown = computed(() => cnameShown.value || noteShown.value);

// ---- the row's popovers ----
// One-at-a-time across the whole list (useItemMenu's singleton), and the folder
// lifts its collapse clip while any is open (overlayToggle). The singleton holds ONE
// open id, so every popover a row can raise is namespaced off the row id
// (`<id>:menu`, `<id>:kcal`, …). That's what makes them mutually exclusive for free
// — opening the calorie popover closes the ⋯ menu, on this row or any other, with
// no cross-wiring between them.
//
// The three MENUS (carrier, nesting, the mobile ⋯ overflow) are <ItemRowMenu>s in
// the template — one component for the chrome and the open/close contract, with
// only their entries written here. The two classification DIALOGS below stay in
// this file: they hold a switch and a field rather than a list of actions.
const menu = useItemMenu();

// ---- the two classification popovers ----
// Both hang off their own toggle and hold: a switch for the class itself, plus the
// one detail that only makes sense while it is on (worn → how many of the qty;
// consumable → calories). Same shape twice, so learning one teaches the other.
//
// Namespaced off the row id like the menus, so the singleton's single openId makes
// every popover on every row mutually exclusive with no cross-wiring.
//
// Placement is measured per open (useMenuPlacement, in its `shift` mode). Flip ABOVE
// the trigger when there isn't room below: a list is long and its last rows sit at
// the viewport floor, where a below-anchored popover opens off-screen — the one
// place the feature is needed is the one place it would be unreachable. Slide RIGHT
// rather than flip to the leading edge when the card runs off the left: it hangs
// off the trigger's right edge, which is correct on a wide row but walks off the
// left of a phone, where the stacked layout puts the toggles near the middle of a
// 375px viewport (the composable's header says why a flip can't serve that case).
// Tooltip.vue solves the same problem but is built around a hover-driven popup
// teleported to <body>; this popover holds a focusable field and stays in the row.
const wornRootRef = useTemplateRef<HTMLElement>("wornRootRef");
const wornPopRef = useTemplateRef<HTMLElement>("wornPopRef");
const isWornOpen = computed(() => menu.openId.value === `${props.item.id}:worn`);
watch(isWornOpen, (open) => emit("overlayToggle", open));
const { above: wornAbove, shift: wornShift, place: placeWorn } = useMenuPlacement(wornPopRef, { fit: "shift" });

// ---- calories (consumable rows only) ----
// Served in a popover hung off the classification control rather than given a
// column: kcal is a fact about food, and food is a minority of a minority of rows.
// A column would cost every row width to serve a few, which is the trade the
// classification select already makes by collapsing three states into one control.
const kcalRootRef = useTemplateRef<HTMLElement>("kcalRootRef");
const kcalPopRef = useTemplateRef<HTMLElement>("kcalPopRef");
const isKcalOpen = computed(() => menu.openId.value === `${props.item.id}:kcal`);
watch(isKcalOpen, (open) => emit("overlayToggle", open));
const { above: kcalAbove, shift: kcalShift, place: placeKcal } = useMenuPlacement(kcalPopRef, { fit: "shift" });

/** Open (or close) one of the row's classification popovers, placing it once the
 *  card exists to measure. `focusField` is false for the worn popover, whose
 *  controls are a switch and a set of buttons — pulling focus to the first of
 *  those would look like a selection had been made. */
async function togglePop(
  kind: "worn" | "kcal",
  rootRef: HTMLElement | null,
  isOpen: boolean,
  place: () => void,
  focusField: boolean,
) {
  const opening = !isOpen;
  menu.toggle(`${props.item.id}:${kind}`, rootRef);
  if (!opening) return;
  // on the tick the card mounts — it has no size to measure before that
  await nextTick();
  place();
  if (focusField) {
    // focus the field on open — the popover exists to take one number, so landing
    // anywhere else would make every use a click plus a tab
    rootRef?.querySelector<HTMLInputElement>("input")?.focus();
  }
}

const toggleWorn = () => togglePop("worn", wornRootRef.value, isWornOpen.value, placeWorn, false);
const toggleKcal = () => togglePop("kcal", kcalRootRef.value, isKcalOpen.value, placeKcal, true);
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
  else if (canIndent.value)
    acts.push({ label: "Nest under the item above", run: () => c.nestItem(props.item.id, props.prevId!) });
  return acts;
});

// ---- carried by (lists with people only) ----
// Who takes this row. A menu hung off its own ghost trigger (the nesting menu's
// shape, placement flip included) rather than a third slot in item__classcell —
// that cell's width is a track the whole page's rows share, and most lists never
// name anyone. The trigger only exists once the list has people; assigned, it
// swaps its glyph for the carrier's own .swatch dot (the vault button's
// state-swap move) — colour stays in a dot, chrome stays ink, and the dot
// carries the state at a contrast a tinted 16px glyph never met.
// The people in display order and their slots come from GearEditor (PEOPLE_CTX):
// sorted once per snapshot for every row, not once per row.
const { sorted: peopleSorted, slotById } = inject(PEOPLE_CTX)!;
// own assignment, else the group's — the shared inherit rule, fed here by the
// parent through the inherited-person-id prop (one level, so one hop resolves it)
const effPersonId = computed(() =>
  effectivePersonId(props.item, { personId: props.inheritedPersonId }),
);
const rowPerson = computed(() => peopleSorted.value.find((p) => p.id === effPersonId.value));
// the row's OWN claim — what the carrier tag shows (an inherited child stays
// untagged, or a six-item group would say the same name seven times), matching
// ReadonlyItemRow's derivation exactly
const ownPerson = computed(() =>
  props.item.personId ? peopleSorted.value.find((p) => p.id === props.item.personId) : undefined,
);
// The slot the FILTER matches this row on — always stamped ("u" = unassigned) so
// the CSS never meets a row without the attribute. Derived from row-local data:
// it changes when an assignment or the people change, never on a filter flip.
const personSlotAttr = computed(() => {
  const slot = effPersonId.value ? slotById.value.get(effPersonId.value) : undefined;
  return slot == null ? "u" : String(slot);
});
const personTitle = computed(() =>
  rowPerson.value
    ? props.item.personId
      ? `Carried by ${rowPerson.value.name}`
      : `Carried by ${rowPerson.value.name} (with the group)`
    : "Who carries this",
);
// One table drives BOTH seats of the picker — the desktop popover and the ⋯
// menu's section — the nestActions shape, so an entry can't exist in one and
// not the other. The clear entry's id is already null, so `active ? null : id`
// both toggles a person off and clears outright.
// The group's own carrier, RESOLVED — what the clear entry below is handing the
// row back TO. Resolved rather than a truthiness test on the id, so a dangling
// assignee the reducer hasn't healed yet is never spoken of as a person.
const groupPerson = computed(() =>
  props.nested && props.inheritedPersonId
    ? peopleSorted.value.find((p) => p.id === props.inheritedPersonId)
    : undefined,
);
const personPicks = computed(() => [
  ...peopleSorted.value.map((p) => ({
    id: p.id as string | null,
    label: p.name,
    color: personColor(p),
    active: props.item.personId === p.id,
  })),
  // a nested row handed back follows its group; a top-level one is simply
  // unclaimed — the label says which return this is ("with the group" alone
  // would read as the trip party, in a list of exactly those people).
  // Nested is not on its own enough to earn that wording: under a group NOBODY
  // carries, following it IS being unassigned, and the group phrasing would name
  // a carrier that isn't there. So it turns on the group having someone.
  {
    id: null,
    label: groupPerson.value ? "Whoever carries the group" : "Unassigned",
    color: undefined,
    active: !props.item.personId,
  },
]);
// null clears (the wire's "hand it back"); a nested row cleared this way returns
// to following its group, which is what the menu's own label for it says
const setPerson = (personId: string | null) => c.updateItem(props.item.id, { personId });

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
//  • Already banked: asking out loud to save what's saved is offering to do what's
//    done — so the button leaves again. (It used to stay, dimmed and
//    aria-disabled, reading "Already in My Gear".) Two ways a row is banked, and
//    for three attempts this only knew the second: My Gear ALREADY HOLDS the gear
//    (vaultKeys — however it got there), or the automatic path is about to put it
//    there for this list (a vault to reach, this list's answer is yes, the chooser
//    didn't decline it). Judging by the second alone made the button reappear on
//    gear that had been banked for months, every time the list's own answer wasn't
//    yes — the same list opened on a second device, a list answered "no", a row
//    unticked in the chooser, anything typed in from /gear. Fail both and the
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
const vaultKey = computed(() => vaultNormKey(props.item.brand, props.item.name, props.item.variant));
const vaultCovered = computed(() => {
  // "signed in, or not yet known to be otherwise" — NOT hasVault alone. That ref
  // is false both for someone signed out and for the moment before
  // /api/auth/me answers, and only the first of those means nothing can have
  // banked this row. Reading them as one put the button on every worthy row of
  // every covered list for the length of that round trip: open a list you built,
  // and gear that has been in My Gear for weeks offered to be saved to it.
  if (vaultKnown.value && !hasVault.value) return false; // no vault, so nothing is in one
  // Same rule one level down, and the ONLY wait: the Map is empty both for an
  // empty vault and for the moment before /api/vault/keys answers, and only the
  // first means the row isn't banked. Deliberately not also gated on vaultKnown —
  // useVaultKeys owns that wait and BOUNDS it (a session lookup that never
  // resolves settles this as known-with-nothing), where reading vaultKnown here
  // hid the button for good on a visitor whose /api/auth/me never came back.
  if (!vaultKeysKnown.value) return true;
  // THE TRUTHFUL TEST, and the one this button spent three attempts without: My
  // Gear either has this piece of gear or it doesn't. It holds however the row got
  // there — a list on another device, an import, a hand-typed row on /gear — and
  // it does not care what this list's capture answer happens to be.
  //
  // Held gear still isn't covered while the row carries a weight the vault would
  // take: capture writes the incoming weight, so correcting one and pressing save
  // does something. Membership alone made the button leave on the first press and
  // never come back, so a weight fixed afterwards could not be pushed from that
  // list at all. `null` is a PINNED weight — you fixed it by hand on /gear and no
  // capture may argue with it — and a row with no weight sends nothing (the
  // upsert ignores a zero), so both are covered.
  if (vaultGear.value.has(vaultKey.value)) {
    const held = vaultGear.value.get(vaultKey.value);
    const mine = Math.max(0, Math.round(props.item.unitWeightMg));
    if (held === null || mine === 0 || held === mine) return true;
  }
  // Not banked yet, but about to be: the automatic path takes this list's gear on
  // the next pause, so offering to do it by hand is offering to do what's already
  // happening. Fail either gate and the worthy row keeps its button, because
  // pressing it is then the only way the row gets banked.
  return c.vaultAuto.value && vaultWorthy.value && !c.vaultDeclined.value.has(vaultKey.value);
});
const vaultSaved = ref(false);
const vaultBusy = ref(false);
const vaultLabel = computed(() =>
  vaultSaved.value ? "Saved to My Gear" : "Save to My Gear",
);
/** Does this row offer the save affordance at all — the inline icon and the ⋯
 *  entry, which must agree.
 *
 *  `vaultSaved` overrides coverage on purpose: the tick IS the feedback for a
 *  press, and a press is the very thing that makes the row covered (the key it
 *  banks lands in vaultKeys immediately). Without this the button answered a
 *  click by vanishing, which reads as the click having gone nowhere. */
const vaultOffered = computed(
  () => !isWater.value && vaultWorthy.value && (vaultSaved.value || !vaultCovered.value),
);
/**
 * Whether the reveal below is allowed to PLAY.
 *
 * The `vaultin` Transition carries no `appear` because, as its keyframes say, "a
 * fresh row (or page) animates nothing; the shine plays only when an EXISTING
 * row's button comes back". Coverage broke that promise without touching the
 * animation: the gate is now false at first paint for a signed-in visitor (the
 * vault read hasn't landed) and flips true a few hundred ms later, which IS an
 * enter transition — so opening a list set every worthy row shining at once, a
 * page-load event the design explicitly excludes.
 *
 * Armed one tick after the gate first settles, so the button's first appearance
 * on any given row is silent and every later one — the row becoming gear, a key
 * leaving the vault — still plays.
 */
const vaultRevealArmed = ref(false);
watch(
  vaultKeysKnown,
  // Disarms on the way DOWN as well. `known` returns to false on every session
  // change (useVaultKeys invalidates, because an answer about the last account is
  // not an answer about this one) — so an arm-only latch let an in-page sign-in
  // take every worthy row through covered and back, playing the whole list's
  // shine at once. That is the same page-load burst this exists to prevent,
  // reached by the most ordinary route into the feature.
  (known) => (known ? nextTick(() => (vaultRevealArmed.value = true)) : (vaultRevealArmed.value = false)),
  { immediate: true },
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
      // You removed this gear on /gear, and capture never resurrects a tombstone
      // — so "try again in a moment" would be a lie and a loop. Say where the way
      // back is, in the words that page uses for it.
      : result === "removed"
        ? "This is in your removed gear — put it back in My Gear first"
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

// the same actions the inline icons run: the one nesting action that applies to this
// row's state (add-nested / nest-up / un-nest), then the vault save, and last the removal — all inline on a desktop row
// and living only here on a phone (see the mobile block: the trailing cluster is
// ⋯ · grip, because the icons are --tap wide there and the line has no room for the
// row's numbers beside more than two of them).
const overflowActions = computed(() => {
  // The nesting entries ARE nestActions — the desktop menu's table, not a second
  // copy of it, so the two seats can't drift on a label. `nest` marks them as the
  // structure edits, which stand down while a person filter is on (CSS off the
  // body attribute — atoms/item.scss; the desktop nest menu hides whole the same
  // way): indent targets the UNFILTERED row above, and a reparent changes what a
  // row inherits, so either can make it vanish from the very view it was touched in.
  const acts: { label: string; run: () => void; nest?: true }[] = nestActions.value.map((a) => ({ ...a, nest: true }));
  // Reads its own state, like the inline button's tooltip does — "Saved" is the
  // whole feedback here, since a menu closes on choosing and there's no tick left
  // on screen to see. Same disclosure rule as the inline icon: no entry until the
  // row is gear worth saving, none again once the automatic path has it (it used
  // to stay as a disabled "Already in My Gear" line) — a menu row that can only
  // say "nothing to do" is an action list advertising a non-action.
  if (vaultOffered.value) acts.push({ label: vaultLabel.value, run: onSaveToVault });
  // LAST, the way the destructive icon sat last in the desktop cluster — a menu is a
  // list you read top to bottom, so the one irreversible entry belongs at the end of
  // it rather than under the thumb. Same words as the icon it replaces ("Remove item",
  // its aria-label and its tooltip), so the action has one name wherever it appears.
  acts.push({ label: "Remove item", run: () => c.removeItem(props.item.id) });
  return acts;
});

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
  <!-- data-person: the row's effective carrier as a SLOT ("u" = unassigned), matched
       by the body's data-filter-person in CSS (atoms/item.scss) — the filter reaches
       this row only as an ancestor attribute, never as a prop -->
  <div
    ref="wrapRef"
    class="item-wrap"
    :data-item-id="item.id"
    :data-parent="item.parentId || null"
    :data-person="personSlotAttr"
    :class="{ 'is-dragging': isDragging, 'is-drop-before': isDropBefore, 'is-nest-parent': isNestParent }"
    @focusout="onRowBlur"
    @click.capture="flushPendingEdit"
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
      <!-- the shared .check atom (controls.scss); .item__box stays on the input for
           the mobile grid placement below (and the print sheet's colour rule) -->
      <span class="check">
        <input
          type="checkbox"
          class="check__box item__box"
          :checked="item.packed"
          :aria-label="`Packed: ${editableName || 'item'}`"
          @change="c.updateItem(item.id, { packed: ($event.target as HTMLInputElement).checked })"
        />
        <!-- absolute-stroke-width pins the drawn line at ~1.33px — what the surrounding
             16px icons render (2 nominal × 16/24) — so the bigger box doesn't read bolder
             than its row -->
        <HugeiconsIcon :icon="SquareIcon" class="check__icon check__icon--empty" :size="20" :stroke-width="1.33" absolute-stroke-width aria-hidden="true" />
        <HugeiconsIcon :icon="CheckmarkSquare02Icon" class="check__icon check__icon--check" :size="20" :stroke-width="1.33" absolute-stroke-width aria-hidden="true" />
      </span>
      <span class="item__cname" :class="{ 'item__cname--group': isParent }"><ItemName :item="item" :group="isParent" /><!--
          the carrier, riding the name cell (display-only — this face is a <label>
          over a checkbox, so a control here would toggle the tick). Only their own
          claim is tagged: children of a claimed group inherit silently, or a
          six-item group would say the same name seven times.
       --><span v-if="ownPerson" class="t-sm item__carrier"><span class="swatch item__carrier-dot" :style="{ background: personColor(ownPerson) }" aria-hidden="true" />{{ ownPerson.name }}</span><NestChevron
          v-if="isParent"
          :collapsed="nestCollapsed"
          :label="item.name || 'group'"
          stop
          @mousedown.prevent
          @toggle="toggleNest"
        /></span>
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
           in it offers the gear type + note below (see nameEditing) -->
      <div class="item__name">
        <!-- the name box: the positioned anchor for the autocomplete menu (so it opens
             under the NAME, not under the sub-line below), the group's name·chevron flex
             line, and the focusin target — landing anywhere in it offers the gear type
             + note underneath (nameEditing); focus arriving in those fields does not. -->
        <div class="item__namebox" :class="{ 'item__namebox--group': isParent }" @focusin="nameEditing = true">
          <ItemInput
            :unit="list.displayUnit"
            :initial="editableName"
            placeholder="Name of item"
            :clear-on-commit="false"
            :autofocus="isPendingBlank"
            @commit="onNameCommit"
            @advance="c.addBlankItemAfter(item.id)"
            @overlay-toggle="$emit('overlayToggle', $event)"
          />
          <!-- collapse a group of nested items — trails the name like the folder's
               chevron (the name hugs its text so this sits right after it) -->
          <!-- the carrier, PHONE-ONLY on this face (see the mobile block): the
               cluster's dot trigger is display:none in the mobile stack, and without
               this the one mode that can assign showed no assignment state at all.
               Desktop stays clean — the trigger's dot already says it. BEFORE the
               chevron, so all three faces read name · carrier · chevron alike. -->
          <span v-if="ownPerson" class="t-sm item__carrier item__ecarrier"><span class="swatch item__carrier-dot" :style="{ background: personColor(ownPerson) }" aria-hidden="true" />{{ ownPerson.name }}</span>
          <NestChevron
            v-if="isParent"
            :collapsed="nestCollapsed"
            :label="item.name || 'group'"
            @mousedown.prevent
            @toggle="toggleNest"
          />
        </div>
        <!-- sub-line: the gear type (a quiet upright label) and, under it, the freeform note;
             both single-line live-text fields, showing whenever they hold a value or the
             name is being edited (see nameEditing). INSIDE the name cell, not under the
             whole row: the gear type is the everyday word for the product above it, so it
             has to sit directly under that name at every width — under the row it landed
             beneath the qty · weight line on a phone, describing the wrong thing. This
             is also what puts the two fields next in the tab order after the name.
             Editing only: the checklist row shows a saved gear type as plain text
             (.item__csub) and no note at all — nothing there is editable; packing hides
             this whole face (atoms/item.scss).
             The .reveal wrapper is a grid whose row animates 1fr↔0fr (Safari-safe slide);
             the two inputs share one inner child so that single-child slide stays clean. -->
        <Transition name="reveal">
          <div v-if="subShown" class="reveal reveal--note">
            <div class="item__subfields">
              <!-- the two placeholders are a matched pair — "Name of item" above, "Type of
                   gear" here — so a blank row reads as one short stack. This field used to
                   show examples only ("Tent, Backpack, Quilt…"), relying on the product name
                   above to explain it; on a blank row there is no name above, so the examples
                   read as a second set of name suggestions. A catalog pick fills this field
                   with a real value anyway, which demonstrates the vocabulary better than a
                   placeholder did. The aria-label carries the same noun for screen readers. -->
              <input
                v-if="cnameShown"
                ref="cnameRef"
                class="item__note item__gtype-input"
                :value="item.commonName ?? ''"
                placeholder="Type of gear"
                aria-label="Gear type"
                autocorrect="off"
                spellcheck="true"
                @change="onCommonName"
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
              />
            </div>
          </div>
        </Transition>
      </div>

      <!-- metadata + controls: display:contents on desktop, so qty/weight/class/
           actions drop into the shared grid columns; on mobile the wrapper turns
           into a flex-wrap row beneath the full-width name so long names never
           truncate (the name takes the whole row, the rest wraps below) -->
      <div class="item__meta">
        <!-- QUANTITY — a stepper, not a box to fill in. Every change to a count is
             ±1 in practice ("take a second gas canister"), and as a bare field that
             cost a click in, a select-all and a keystroke to move a 1 to a 2.
             The number is STILL a field, because the tail of the distribution is
             real — fourteen tent stakes shouldn't be fourteen presses — it just
             stopped being the only way in. It carries no box of its own: between the
             two buttons it reads as the stepper's value rather than as a third
             control (see .item__qty--step).
             ON THE DESKTOP GRID ONLY. Every part of the row is rendered here and the
             MODE picks which parts show, the same division the editing↔packing swap
             makes: a media query can decide this, a prop would re-render every row on
             every resize. The mobile line is where the ± stand down and the "×" comes
             back to punctuate the count instead — nine controls already share 343px
             there, and with no columns to separate them the stepper's + landed
             against the weight and "− 4 + 540 g" read as one run-on figure. The
             grid's own columns are what make the same three parts legible up here.
             WATER is the exception at every width and keeps the plain field: that
             cell holds LITRES — a continuous measure driving the row's weight, not a
             count — so ±1 would be both the wrong step and the wrong idea. -->
        <div class="item__qty" :class="{ 'item__qty--step': !isWater }">
          <template v-if="isWater">
            <input
              class="field field--num"
              type="number"
              min="0"
              step="any"
              :value="litersDisplay"
              aria-label="Litres of water"
              @change="onWaterLiters"
            />
            <span class="t-sm t-muted item__unit">L</span>
          </template>
          <template v-else>
            <!-- mousedown.prevent for the reason the action icons carry it: on
                 macOS Safari/Firefox a button takes no focus on mousedown, so a
                 press from inside the row's name field blurs the row — and a
                 pristine blank row discards itself on that blur. Holding focus is
                 also what lets you press + three times without the caret leaving
                 the field you were typing in.
                 The names carry the ITEM, like the grip's and the checkbox's do:
                 "One more, button" on its own says nothing about what of. -->
            <button
              class="btn btn--icon btn--ghost item__qtybtn"
              type="button"
              :disabled="item.qty <= 1"
              :aria-label="`One fewer ${item.name || 'item'}`"
              @mousedown.prevent
              @click="stepQty(-1)"
            >
              <HugeiconsIcon :icon="MinusSignIcon" :size="16" :stroke-width="2" />
            </button>
            <!-- is-popping only ever comes from the STEPPER (popQty). Typing a
                 number already shows you the number; popping the field on a commit
                 you are looking at is motion reporting your own keystroke back. -->
            <input
              ref="qtyFieldRef"
              class="field field--num item__qtyfield"
              :class="{ 'is-popping': qtyPopping }"
              type="number"
              min="1"
              :max="QTY_MAX"
              step="1"
              :value="item.qty"
              aria-label="Quantity"
              @change="onQty"
            />
            <!-- the mobile line's punctuation, hidden on the grid where the columns
                 do that job (and where a fourth thing wouldn't fit the track). It
                 trails the number in the markup because that is where it reads —
                 the + beside it is the one that stands down below $bp-stack. -->
            <span class="t-sm t-muted item__unit">×</span>
            <button
              class="btn btn--icon btn--ghost item__qtybtn"
              type="button"
              :disabled="item.qty >= QTY_MAX"
              :aria-label="`One more ${item.name || 'item'}`"
              @mousedown.prevent
              @click="stepQty(1)"
            >
              <HugeiconsIcon :icon="PlusSignIcon" :size="16" :stroke-width="2" />
            </button>
          </template>
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
               (whose figure is the sum of children that may each read differently) —
               those two show the unit as plain text, with no unit to pick. -->
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
          <!-- overlay-toggle forwarded like the name autocomplete's: the menu opens
               downward, so on the folder's last row it crosses the collapse clip
               (and a last CHILD row crosses its group's nest clip too — the parent's
               onChildOverlay lift rides the same event on the way up) -->
          <OptionMenu
            v-else
            class="item__unitwrap"
            :options="WEIGHT_UNIT_OPTIONS"
            :current="rowUnit"
            label="Weight unit for this item"
            :title="`Unit for ${item.name || 'this item'}`"
            @pick="(u) => onRowUnit(u as Unit)"
            @overlay-toggle="$emit('overlayToggle', $event)"
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
            <Tooltip text="Consumable" :disabled="isKcalOpen" preferred-placement="top">
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
                ref="kcalPopRef"
                class="popover item__pop"
                :class="{ 'is-above': kcalAbove }"
                :style="kcalShift ? { translate: kcalShift + 'px 0' } : undefined"
                role="dialog"
                aria-label="Consumable"
              >
                <div class="switch-row">
                  <span class="t-sm">Consumable</span>
                  <!-- The name has to OPEN with the visible label. WCAG 2.5.3 asks
                       that a control's accessible name contain the text you can see
                       beside it, and "Food, fuel or water" — good as the gloss is —
                       shares not one word with the "Consumable" printed next to it.
                       The cost is real and not theoretical: speech input matches on
                       the accessible name, so "click Consumable" hit nothing.
                       The gloss stays, after the label, because it is the sentence
                       that says what the word means. (The worn switch below needs no
                       such repair — "Worn on your body" already opens with "Worn".) -->
                  <button
                    class="switch"
                    type="button"
                    role="switch"
                    :aria-checked="isConsumable"
                    aria-label="Consumable — food, fuel or water"
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
               controls that lie. A DROPLET rather than the cookie every other
               consumable wears — same class, same lit chip, same "Consumable" name,
               but the picture matches the one consumable the app already treats as
               its own thing. The read view draws the same swap (see consumableIcon). -->
          <div v-else class="item__cls">
            <Tooltip text="Consumable" preferred-placement="top">
              <span class="item__clsfixed item__mark" role="img" aria-label="Consumable">
                <HugeiconsIcon :icon="DropletIcon" :size="16" :stroke-width="2" />
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
                ref="wornPopRef"
                class="popover item__pop"
                :class="{ 'is-above': wornAbove }"
                :style="wornShift ? { translate: wornShift + 'px 0' } : undefined"
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
          <Transition name="vaultin" :css="vaultRevealArmed">
            <Tooltip v-if="vaultOffered" :text="vaultLabel" preferred-placement="top">
              <button
                class="btn btn--icon btn--ghost item__vault-btn"
                :class="{ 'is-active': vaultSaved }"
                type="button"
                :disabled="vaultBusy"
                :aria-label="vaultLabel"
                @mousedown.prevent
                @click="onSaveToVault"
              >
                <HugeiconsIcon :icon="vaultSaved ? CheckIcon : SafeBoxIcon" :size="16" :stroke-width="2" />
              </button>
            </Tooltip>
          </Transition>
          <!-- CARRIED BY. Exists only once the list names people (the ⋯ menu carries
               the same entries on mobile, where this cluster collapses). Sits with the
               conditional icons at the cluster's open edge for the vault button's
               reason: its coming and going must shuffle nothing. Assigned, the glyph
               becomes the carrier's own dot — the vault button's state-swap, with the
               colour kept in a .swatch where this app keeps all of it. -->
          <ItemRowMenu
            v-if="peopleSorted.length"
            class="item__person"
            :row-id="item.id"
            kind="person"
            :label="personTitle"
            menu-label="Who carries this"
            trigger-class="item__person-btn"
            tooltip
            @overlay-toggle="$emit('overlayToggle', $event)"
          >
            <template #trigger>
              <span v-if="rowPerson" class="swatch" :style="{ background: personColor(rowPerson) }" aria-hidden="true" />
              <HugeiconsIcon v-else :icon="UserIcon" :size="16" :stroke-width="2" />
            </template>
            <li v-for="e in personPicks" :key="e.id ?? 'none'" role="none">
              <button
                type="button"
                role="menuitemradio"
                class="menu__item item__personpick"
                :class="{ 'is-active': e.active }"
                :aria-checked="e.active"
                @click="menu.close(); setPerson(e.active ? null : e.id)"
              >
                <span class="swatch" :class="{ 'swatch--hollow': !e.color }" :style="e.color ? { background: e.color } : undefined" aria-hidden="true" />
                {{ e.label }}
              </button>
            </li>
          </ItemRowMenu>
          <!-- NESTING, under one icon. These were up to two adjacent buttons whose
               glyphs (list-plus, indent, outdent) are near-identical at 16px, so the
               cluster read as noise and you had to hover each to learn which was which.
               One trigger, and the menu SAYS what each action does.
               Rendered only when there is something to offer — a nested row that can't
               un-nest, or a parent with nothing to indent under, gets no icon at all
               rather than a menu that opens empty.
               item__nestact: stands down while a person filter is on (atoms/item.scss)
               — "the item above" is unfiltered order, so indent could target a row the
               CSS is hiding, and a nested row inherits its parent, so either action
               can make the row vanish from the very view it was touched in. -->
          <ItemRowMenu
            v-if="nestActions.length"
            class="item__nest item__nestact"
            :row-id="item.id"
            kind="nest"
            label="Nesting"
            :icon="ListIndentIncreaseIcon"
            trigger-class="item__nest-btn"
            tooltip
            @overlay-toggle="$emit('overlayToggle', $event)"
          >
            <li v-for="a in nestActions" :key="a.label" role="none">
              <button type="button" role="menuitem" class="menu__item" @click="menu.close(); a.run()">{{ a.label }}</button>
            </li>
          </ItemRowMenu>
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
          <!-- mobile overflow: on a phone the trailing icons crowd the two-line row, so
               everything EXCEPT delete + grip collapses in here — the carrier picker,
               the nesting actions and the vault save — and desktop, which keeps the
               inline icons, never shows it. Same .menu/.popover atom as the editor's ⋯
               kebab; one row's menu open at a time (useItemMenu). -->
          <ItemRowMenu
            class="item__more"
            :row-id="item.id"
            kind="menu"
            label="More actions"
            menu-label="Item actions"
            :icon="CircleEllipsisIcon"
            trigger-class="menu__btn item__morebtn"
            @overlay-toggle="$emit('overlayToggle', $event)"
          >
            <!-- the person picker's mobile seat — the desktop trigger is
                 display:none here, so its popover would anchor to nothing. The
                 SAME personPicks table as that popover, so the two seats can't
                 drift. FIRST, not last: the assign run-through taps these forty
                 times, and "Remove item" keeps the menu's closing seat — the
                 one irreversible entry belongs at the end, not under the thumb.
                 A real role=group with a visible name, so the radio run reads
                 as one setting to assistive tech instead of loose siblings. -->
            <li v-if="peopleSorted.length" role="none">
              <ul role="group" aria-label="Who carries this" class="item__moregroup">
                <!-- aria-hidden: the group's aria-label already names it — role=none
                     strips the li's semantics but not its TEXT, so without this a
                     screen reader heard the label twice -->
                <li role="none" class="t-label item__morelabel" aria-hidden="true">Who carries this</li>
                <li v-for="e in personPicks" :key="e.id ?? 'none'" role="none">
                  <button
                    type="button"
                    role="menuitemradio"
                    class="menu__item item__personpick"
                    :class="{ 'is-active': e.active }"
                    :aria-checked="e.active"
                    @click="menu.close(); setPerson(e.active ? null : e.id)"
                  >
                    <span class="swatch" :class="{ 'swatch--hollow': !e.color }" :style="e.color ? { background: e.color } : undefined" aria-hidden="true" />
                    {{ e.label }}
                  </button>
                </li>
              </ul>
            </li>
            <li v-for="a in overflowActions" :key="a.label" role="none" :class="{ item__nestact: a.nest }">
              <button type="button" role="menuitem" class="menu__item" @click="menu.close(); a.run()">{{ a.label }}</button>
            </li>
          </ItemRowMenu>
          <!-- drag via pointerdown; arrow keys give the focused grip the reordering
               its label promises (a drag needs a pointer) -->
          <button
            class="btn btn--icon btn--ghost grip item__grip"
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
          nested
          :inherited-person-id="effPersonId"
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
.item__name {
  grid-area: name;
  min-width: 0;
}
/* position:relative makes the name BOX the autocomplete dropdown's anchor, so the
   menu opens flush with the row's left edge, directly under the name field (not under
   the sub-line that shares the cell), and its width math is box-based (see ItemInput
   .ac__menu) — the .ac root inside defers via position:static. */
.item__namebox {
  position: relative;
  min-width: 0;
}
.item__namebox :deep(.ac) {
  position: static;
}
/* a GROUP (parent) row: the name hugs its text so the collapse chevron trails it,
   exactly like a folder header (.folder__title / .folder__name / .folder__collapse) */
.item__namebox--group {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
}
.item__namebox--group :deep(.ac) {
  flex: 0 1 auto;
  min-width: 0;
}
.item__namebox--group :deep(.ac__input) {
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
   .item__nestcollapse / .item__nestchev recipe in atoms/folder.scss, which it shares
   with the folder header's chevron — one recipe for the edit row, the packing row
   (.item__cname--group below), and the share views. */
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
  /* CENTRED in a box the height of the field track, pinned to the row's TOP — not
     align-self:center in the grid area. The area is as tall as the name cell, and the
     name cell grows when its sub-line (gear type / note) opens; centring in it sank
     every icon to the middle of a two- or three-line cell. A --field-h box at the top
     centres the glyph on the name line whether or not anything is open under it. */
  align-self: start;
  height: var(--field-h);
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
/* same box for the trailing cluster — it carried the same 2px lift, and the same
   sink once the name cell could grow; fixing only the middle one would leave two
   icon groups at two heights */
.item__actions {
  grid-area: actions;
  align-self: start;
  height: var(--field-h);
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
/* checkbox — the shared .check atom (controls.scss): Square (empty) under
   SquareCheck (checked), the same glyph as the header's packing toggle, stacked in
   one grid cell with the native control stretched invisibly over them. 20px — a
   step up from the old 18px drawn box; the icons pin their stroke at ~1.33px
   (absolute-stroke-width) so the bigger box keeps the same line weight the
   surrounding 16px icons render. The row's only addition: the whole box is the tap
   target, so pointing at it darkens the glyph like the row's other quiet marks. */
.check:hover .check__icon {
  color: var(--ink);
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
/* ---- the quantity stepper: − · the number · + ----
   CENTRED in the row rather than baseline-aligned, the classification cell's fix for
   the same problem: a flex box whose first child is a button has no text baseline to
   offer, so the grid would synthesize one from that button's bottom edge and hang the
   whole stepper off it. Centred inside a --field-h box pinned to the row's TOP (the
   classification cell and the actions cluster ride the same box): every box on the
   name LINE is --field-h tall, so that puts the number's baseline exactly where
   baseline alignment did — and the box, not the grid area, is what it centres in,
   because the area grows with the name cell once its sub-line (gear type / note)
   opens, and centring in that sank the stepper a line below the weight beside it.
   space-between, not a gap: the two buttons take the track's ends, which is what
   makes a column of them line up down the list while the numbers between them stay
   centred on their own. */
.item__qty--step {
  align-self: start;
  height: var(--field-h);
  align-items: center;
  justify-content: space-between;
  gap: 0;
}
/* the number carries NO box of its own — bare and centred between the buttons, it
   reads as the stepper's value rather than as a third control sitting between two */
.item__qty--step .field {
  flex: 1 1 auto;
  text-align: center;
}
/* the × is the MOBILE line's punctuation only (see the markup): up here the grid's
   columns already separate the count from the weight, and a fourth part would have
   to come out of a track sized for three */
.item__qty--step .item__unit {
  display: none;
}
/* WATER keeps a plain field (litres, not a count) — but it has to keep the stepper's
   GEOMETRY, or its number sits out at the track's right edge while every other row's
   sits mid-track, and the column reads ragged. Which is the whole point of a shared
   track: a number belongs under the number above it.
   So every row in this column has the SAME three slots — a gutter one ± button wide,
   the number centred in what's left, a gutter on the right. A water row simply has
   nothing in the first and its "L" in the last, where the + sits on the rows above. */
.item__qty:not(.item__qty--step) {
  gap: 0;
  padding-left: var(--qty-btn);
}
.item__qty:not(.item__qty--step) .field {
  flex: 1 1 auto;
  text-align: center;
}
.item__qty:not(.item__qty--step) .item__unit {
  width: var(--qty-btn);
}
/* Narrower than --icon-btn (see --qty-btn, tokens.scss): the three parts have to read
   as ONE control. Colour + hover come from the row's shared quiet-icon rules below,
   so the ± sit at the same weight as every other glyph on the row. */
.item__qtybtn {
  flex: none;
  width: var(--qty-btn);
}
/* A coarse pointer WIDE enough to still be on the grid — a tablet in landscape, a
   touch laptop. (Below $bp-stack the stepper isn't rendered at all, so this is the
   only case.) It's the one icon button that doesn't widen to --tap there, because
   --item-col-qty is derived from --qty-btn: at 44px the track would want 132px, and
   it would take that from the name column on the widest rows in the app.
   The HEIGHT still grows, so the target is 24×44 — past the 24×24 floor (WCAG 2.5.8)
   in both directions, and full height under the finger. The glyph holds at 16px too:
   .btn--icon grows it to --icon-touch on touch, which in a 24px box leaves the plus
   with no air around it. */
@media (pointer: coarse) {
  .item__qtybtn {
    width: var(--qty-btn);
    min-height: var(--tap);
  }
  .item__qtybtn svg {
    width: 16px;
    height: 16px;
  }
}
/* the pop when the stepper moves the number — the shared `num-pop` keyframe
   (main.scss), the one the big total takes when it changes. blur(0) at rest, never
   `none`: the filter context has to persist between runs or WebKit drops it. */
.item__qtyfield {
  filter: blur(0);
  transform: translateZ(0);
}
.item__qtyfield.is-popping {
  animation: num-pop var(--dur-slow) var(--ease-spring) both;
}
.item__unitwrap {
  position: relative;
  flex: none;
  display: inline-flex;
  /* centres the chevron ON the unit's text rather than letting it stretch. The wrap
     still contributes the unit's own baseline upward, so the number and its unit stay
     on one line with the rest of the row. */
  align-items: center;
  /* The SAME gap `.optmenu__btn` puts between its trigger's parts (both read the one
     token, so this is a shared value and not a copied number).
     It is load-bearing on the plain water/group variant, where this element IS the
     unit-and-chevron box; on the picker variant that box is the button inside, so the
     declaration is inert there and only one rule is needed for both.
     Without it the ghost chevron reserved the chevron's WIDTH but not the space the
     button holds before it, so the two variants' wraps measured 21px and 29px. The
     chevrons still lined up — they're pinned to the cell's trailing edge — and the
     "g" did not: it sat 8px right of every editable row's, which put a water or group
     row's unit out of the column it exists to keep. */
  gap: var(--space-2);
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
  /* The box the padding above was assuming, which nothing had actually declared.
     A BUTTON gets it from .btn--icon, whose own coarse rule takes width and
     min-height to --tap (controls.scss). The fixed mark is a <span> and gets
     nothing — it stayed pinned at --icon-btn, and since box-sizing is border-box
     the padding didn't grow it, it just ate 12px out of the 32 the glyph had.
     Two visible faults, both only on a touch pointer:
       • 32 wide against the toggles' 44, so a water row's cell measured 68 where
         every other row's measured 92. Both cells are right-anchored, so the
         difference came out of the LEADING slot and pushed water's cookie 24px
         right of the cookie column it exists to sit in — the column the comment
         above says this rule is here to hold.
       • --radius-pill over a 32×44 box draws a tall OVAL, not a chip, so a lit
         water mark was a different shape from a lit toggle.
     Stated as the same two properties .btn--icon's coarse rule sets, so the mark
     and the button it stands in for can't measure differently again. */
  .item__clsfixed {
    width: var(--tap);
    min-height: var(--tap);
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
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss) */
@media (hover: hover) and (pointer: fine) {
  .item__split:hover {
    background: var(--paper-3);
    color: var(--ink);
  }
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
/* right-align the trailing glyphs (remove · grip) in their tap targets so they
   read as evenly spaced with the grip flush to the edge — centering the others
   while the grip sat hard-right left an uneven, wider gap before the grip.
   :deep() because three of the cluster's triggers are rendered by ItemRowMenu
   now, and a scoped rule doesn't cross into a child's own elements. */
.item__actions :deep(.btn--icon) {
  justify-content: flex-end;
}
/* (the three menu triggers — carrier, nesting, ⋯ — take the same treatment from
   ItemRowMenu's own scoped block, which is the only place a rule can reach them) */
.item__grip,
.item__vault-btn,
.item__del,
/* the qty stepper's ± live in this family too, though they sit in the middle of the
   row rather than the trailing cluster: they are the same kind of thing (a quiet
   glyph that darkens under the pointer), and one rule is what keeps them the same
   weight as the icons across the row from them */
.item__qtybtn {
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.item__grip:hover,
.item__vault-btn:hover,
.item__del:hover,
.item__qtybtn:hover {
  color: var(--ink);
}
/* banked: the tick holds at full ink so the row keeps saying so */
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
/* grip is the last icon in the trailing actions cluster (note · remove · grip); the
   drag affordance + flush-right optics are the .grip atom (controls.scss), sizing and
   colour .btn--icon / the shared colour rule above */

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

/* ---- carried by ---- */
/* NO .item__mark ground on this one, unlike the classification toggles. That atom
   clips its pill to the CONTENT box, and .btn--icon is padding:0 at --icon-btn — so
   the ground is always the full 32px, centred at 16. Every other glyph in this
   cluster is right-aligned (above, so the grip reads flush) and therefore centres at
   24. A 32px ground simply cannot sit on that column, so the chip either hung 8px
   left of every icon beside it or, right-aligned, left its own dot jammed against
   its edge. The dot's COLOUR is the state here — a saturated hue against an outline
   User glyph — which is the whole reason this button swaps glyph for swatch; a grey
   disc behind it was the redundant half, and the loud one in a dense list.
   The dot then rides the glyph column like everything else: half the difference
   between a 16px glyph's footprint and the swatch, taken off the right, puts its
   centre at 24 instead of 3px past it. */
/* (still reaches: the swatch is this component's slot content into ItemRowMenu, so
   it carries this scope id even though the button around it doesn't) */
.item__person-btn .swatch {
  margin-right: calc((16px - var(--swatch)) / 2);
}
/* the carrier tag itself is the shared .item__carrier atom (atoms/item.scss) —
   drawn once for this face, the checklist face and the read rows */
/* the edit face's copy exists only where the trigger's dot doesn't: the phone
   (the trigger is display:none in the mobile block below, which reveals this) */
.item__ecarrier {
  display: none;
}
/* picker entries: a dot beside each name; the chosen one wears the on-plate */
.item__personpick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.item__personpick.is-active {
  background: var(--lit);
  color: var(--ink);
}
/* the ⋯ menu's group label above the person entries — the entries' own inline
   padding (space-3, controls.scss), so its text sits flush with theirs */
.item__morelabel {
  padding: var(--space-2) var(--space-3) var(--space-1);
  color: var(--ink-3);
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
  /* The sub-line sits directly under the name field here as on desktop, but the mobile
     name field is a text-tight box (padding-block 2px, see above), so the desktop tuck
     (sized to cancel a 36px field's dead space) has nothing to cancel. This is a GAP,
     and it's the row's own gap: --space-1 is what .item puts between the name cell and
     the meta line, and what .item__subfields puts between the gear type and the note.
     Name, gear type, note, meta — one rhythm. Still routed through this hook, so the
     offset retires with the height on close. */
  .reveal--note {
    --reveal-offset: var(--space-1);
  }
  /* qty · weight · class on the left, controls on the right. Two lines per row (name
     + this) is still the target and still what almost every row gets — but the line
     WRAPS when it genuinely can't hold, rather than running its trailing icons off
     the side of the phone.
     It used to be nowrap, with a `max-width: 360px and pointer: coarse` carve-out
     below that flipped it to wrap — the one width where nowrap was measured to fail.
     That was the wrong shape for the rule: it named a width, and the answer it gave
     there ("let it wrap") is the answer at every width where the line doesn't fit.
     A breakpoint only holds until the next thing joins the line — the gap floor just
     below moved it once already — and when it stops holding the failure is not a
     tight row but a grip sitting past the edge of the screen.
     flex-wrap is self-tuning instead: a row that fits is untouched (wrap does nothing
     when there is no overflow to resolve), and a row that doesn't drops its actions
     cluster to a line of its own — exactly what the 360px block did, for the same
     reason. A third line is a worse row than two; an unreachable grip is not a row
     at all. */
  .item__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    /* Generous gap BETWEEN the groups (qty · weight · class) so they read as
       distinct — each number stays tight to its own ×/unit (see .item__qty gap +
       the 1ch field min-width); this is the separation between those pairs.
       It SHRINKS on the narrowest screens rather than holding at space-4 and
       overflowing. Once the classification cell became two toggles, a coarse
       pointer's --tap sizing left this line needing more width than a 375px phone
       has, and a fixed gap spends on air the controls need. Above ~640px it
       resolves to space-4 and nothing changes.
       The FLOOR is --space-3, not --space-2. At 8px the separation between the
       groups was only 4px more than the separation inside them (a number and its
       own unit), which is not a difference you can see — "1 × 540 g" read as one
       run of figures rather than a count and a weight. 12px against 4px is a ratio
       you can, and it is the one piece of this the grid gets for free from having
       columns at all. The 4px it costs a 375px line is affordable; below that the
       line wraps, which it already did. */
    gap: clamp(var(--space-3), 2vw, var(--space-4));
    /* but the gap BETWEEN wrapped lines is the row's own rhythm, not the columns'
       separation — the same --space-1 the name and this line already sit apart by.
       After the shorthand, which would otherwise set both. */
    row-gap: var(--space-1);
    /* Right-aligns the actions on the line the auto margin can't reach: when the
       cluster wraps to a line of its own there is no classification cell down there
       to carry it (.item__classcell below is what right-anchors the fitting case).
       justify-content rather than a second margin-left:auto, because two auto margins
       SPLIT the free space between them on any row that still fits on one line, which
       puts back half the drift the first one exists to remove. justify-content can't
       do that: an auto margin consumes the free space before it is consulted, so this
       stays inert on a line that has one and takes charge on the line that doesn't. */
    justify-content: flex-end;
  }
  .item__actions {
    flex: none;
    align-self: center;
    height: auto; /* the desktop --field-h box is for the grid row; here the cluster rides the flex line */
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
  .item__actions :deep(.btn--icon),
  .item__classcell .btn--icon,
  .item__classcell .item__clsfixed {
    min-height: 0;
    height: var(--tap);
    margin-block: var(--tap-pull);
  }
  /* …and then the class cell's two boxes have to be squared back off, because those
     two PAINT. The rule above grows the height alone, and --radius-pill over the
     resulting 32×44 draws a tall OVAL — the same fault the coarse rule below the
     toggles was written to fix, arriving here by the other door.
     WIDTH plus padding, not padding alone. Padding alone looks like it should work,
     since .item__mark clips its ground to the CONTENT box (atoms/item.scss) — but a
     clipped background keeps the border box's corner radii minus the padding PER
     AXIS, so 6px of block padding took the vertical radius to 10 and left the
     horizontal at 16: a 32×32 ground with its sides shaved flat. Squaring the border
     box first is what makes the inset radii equal, and a circle come out.
     These are the coarse rule's own two values, so a phone — which matches both
     queries — is already drawing exactly this. What this adds is the narrow DESKTOP
     window, which until now got the height without the width. */
  .item__classcell .btn--icon,
  .item__classcell .item__clsfixed {
    width: var(--tap);
    padding: calc((var(--tap) - var(--icon-btn)) / 2);
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
     Hide each departed one's BOX, not just the button in it. Two of them sit inside a
     <Tooltip>, which renders a .tooltip-trigger wrapper, and the nesting menu has its
     own .menu div — hiding only the button leaves those wrappers as zero-width flex
     items, and a zero-width flex item still takes its share of the cluster's gap. That
     was three phantom 4px gaps inside a cluster whose visible content is two buttons,
     and the nesting one is CONDITIONAL (a group row offers no nest action), so the
     cluster came out 4px narrower on group rows than on the rest — enough to knock
     those rows out of the column the classification cell now rides. :has() is what
     reaches a wrapper from the hidden button inside it; the alternative is a class per
     Tooltip, which is markup spent on saying what the button already says. */
  .item__nest,
  .item__person,
  .item__actions .tooltip-trigger:has(.item__vault-btn),
  .item__actions .tooltip-trigger:has(.item__del) {
    display: none;
  }
  .item__more {
    display: inline-flex;
  }
  /* …and the assignment state the hidden trigger was carrying comes back as the
     name-line tag, or the one mode that can assign would show none at all */
  .item__ecarrier {
    display: inline-flex;
  }
  /* the name box is a plain BLOCK on a non-group row (only --group is a flex
     row), so without this the tag dropped to its own line under the field,
     aligned to nothing — make the box the baseline row the group variant
     already is, the field taking the slack, the gap carrying the spacing */
  .item__namebox:has(.item__ecarrier) {
    display: flex;
    align-items: baseline;
    gap: var(--space-1);
  }
  .item__namebox:has(.item__ecarrier) :deep(.ac) {
    flex: 1 1 auto;
    min-width: 0;
  }
  .item__namebox:has(.item__ecarrier) .item__ecarrier {
    margin-left: 0; /* the flex gap is the spacing here — the atom's margin doubled it */
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
    height: auto; /* as .item__actions: the --field-h box is desktop-grid furniture */
  }
  /* the number fields have no grid column to fill on mobile, so give them compact
     explicit widths — otherwise width:100% balloons to the default text-input size
     and each control wraps onto its own line */
  .item__qty,
  .item__weight {
    flex: none;
  }
  .item__qty--step {
    height: auto; /* the --field-h box is desktop-grid furniture; here the stepper stands down and the count rides the flex line */
  }
  /* THE STEPPER STANDS DOWN HERE, and the count goes back to a plain number and its
     ×. Nine controls already share this line at 375px, and unlike the grid it has no
     columns to separate them — so the + landed hard against the weight and
     "− 4 + 540 g" read as one run-on figure rather than a count and a weight. The ×
     is what punctuates the count without costing a tap target.
     display:none, so the buttons leave the accessibility tree with the pixels — a
     control you cannot see is not one to offer a screen reader either. The field is
     still a field, so nothing about setting a quantity is lost down here; it is the
     affordance that's desktop-only, not the capability. */
  .item__qtybtn {
    display: none;
  }
  .item__qty--step .item__unit {
    display: block; /* the flex item it already was — restoring, not restyling */
  }
  /* flush-left on the flowing mobile row — the global right-align is for the desktop
     columns; here it would indent a short value (e.g. "1") from the viewport edge */
  .item-wrap .item__qty .field,
  .item__weight .field {
    text-align: left;
  }
  /* and the cell gives back the stepper's geometry with it — both variants, since
     both are a plain field down here. That reserved button gutter, the zero gap and
     the sized unit slot exist to hold a COLUMN together; this line has none, and the
     fields size to their own content, so all three would only spend width the
     tightest line in the app hasn't got.
     The .item-wrap prefix here and above (the block's own idiom — see .item-wrap
     .item .field) is what MATCHES the water rules being undone: those are written
     `.item__qty:not(.item__qty--step)`, and a bare `.item__qty` is a class short of
     that, so it lost to them and left a water row still carrying its 24px gutter. */
  .item-wrap .item__qty {
    gap: var(--space-1);
    padding-left: 0;
  }
  .item-wrap .item__qty .item__unit {
    width: auto;
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
     whole two-line cell) — it sits beside the name, centred to that first row.
     .item__box is the row's own hook on the .check atom's input, kept for this. */
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
    grid-row: 3;
  }
  /* the qty/weight cells' compact box metrics are shared with the read rows —
     atoms/item.scss */
  .item__cweight {
    grid-column: 3;
    grid-row: 3;
    justify-self: start;
    text-align: left;
  }
  /* the gear type on the line directly under the name (it is the everyday word for
     that name — the edit and read faces put it there too), ×qty · weight below it;
     aligned to the name column. The row-gap gives the spacing so drop the desktop
     upward tuck. */
  .item__csub {
    grid-column: 2 / -1;
    grid-row: 2;
    margin-top: 0;
  }
}

/* The narrowest-phone block that used to live here (max-width: 360px and pointer:
 * coarse — wrap the meta line, right-align the wrapped actions) is gone: both of its
 * declarations moved up into the mobile block unconditionally when the quantity
 * stepper widened the line. A breakpoint was the wrong shape for the rule anyway —
 * it named the one width at which nowrap was known to fail, and the answer it gave
 * ("let it wrap") is the answer at every width where it fails. See .item__meta.
 */
</style>
