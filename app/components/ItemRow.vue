<script lang="ts">
import { IconArrowsRepeatCircle, IconCodeTree, IconCalculator, IconCheckmark1Medium, IconChevronDownMedium, IconCircleDotsCenter1, IconDotGrid2x3, IconFashion, IconFormSquare, IconSlideAdd, IconListAdd, IconMinusMedium, IconPencil2, IconPlusMedium, IconSquareCheck, IconSquareMinus, IconTextIndentLeft, IconTextIndentRight, IconTrashCan, IconUserEdit, IconSafeSimple } from "~/icons/central";
import type { InjectionKey, Ref } from "vue";
import type { Item as ItemT, Person, Unit } from "~~/shared/types";

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
//  • the rows whose variant DISAMBIGUATES — the same product held in two variants
//    (shared/variantShown) — one pass per snapshot, where each row asking for
//    itself would scan the whole list for a twin
export const CHILDREN_BY_PARENT: InjectionKey<Readonly<Ref<Map<string, ItemT[]>>>> =
  Symbol("childrenByParent");
export const PEOPLE_CTX: InjectionKey<{
  sorted: Readonly<Ref<Person[]>>;
  slotById: Readonly<Ref<Map<string, number>>>;
}> = Symbol("people");
export const VARIANT_SHOWN: InjectionKey<Readonly<Ref<ReadonlySet<string>>>> = Symbol("variantShown");
// ...and the editor's toast, for the one thing a row has to SAY (a save to My Gear that
// didn't land). Reached the same way: it was an event relayed up through the nested
// row, the folder's rows and the folder, four components that had nothing to add to it.
export const ROW_FLASH: InjectionKey<(message: string) => void> = Symbol("flash");

// static per-component tables — module scope so a large list doesn't rebuild
// them in every row instance
// one stable empty array for every leaf row, so `children` never mints a fresh
// identity per row per render
const NO_ITEMS: ItemT[] = [];
// Per-item nest-collapse, remembered on this device under gear.nest.<id>
const nestCollapse = usePersistedCollapse("gear.nest.");

// What a row can count as, in the totals bar's order and its words. `name` is the
// option's accessible name: it OPENS with the visible label (WCAG 2.5.3: speech input
// matches on the name, so "click Consumable" has to hit) and then says what the word
// means. EVERY row gets all three, stove fuel included: a card that left Worn out there
// was the one card of a different shape, and the rule that reads a row as fuel also
// catches a fuel bottle and a gas stove (Ryan, 2026-11-25: "feels confused on fuel").
const CLASS_OPTIONS = [
  { key: "base", label: "Base", name: "Base: in your pack" },
  { key: "worn", label: "Worn", name: "Worn on your body" },
  { key: "consumable", label: "Consumable", name: "Consumable: food, fuel, or water" },
] as const;
</script>

<script setup lang="ts">
import { SvgIcon, type IconNode } from "~/utils/icon";
import type { Item, ListSnapshot } from "~~/shared/types";
import type { ItemPatch } from "~~/shared/ops";
import { MAX_GEAR_TYPE_LEN, MAX_ITEM_NOTE_LEN, MAX_QTY, MAX_VARIANT_LEN } from "~~/shared/ops";
import { effectivePersonId, personColor } from "~~/shared/people";
import { tickRows, tickState } from "~~/shared/packing";
import type { NameCommit } from "~/composables/useCatalogSearch";
import { keptGearType, pickFromCatalog } from "~~/shared/catalogMatch";
import { bySortOrder, entryUnitFromInput, formatKcal, formatWeight, isBareGroup, parseKcal, parseWeightInput, groupLineMg, siblingItems, storedClassification } from "~~/shared/weights";
import { isWaterName, itemQtyLabel } from "~~/shared/water";
import { useItemRowFields } from "~/composables/useItemRowFields";
import { useItemRowClassification } from "~/composables/useItemRowClassification";
import { UnsetRingGlyph, VerifiedGlyph } from "~/icons/mahonia";
import { consumableIcon } from "~/utils/itemMarks";
import { ASSUMED_FUEL_PER_BOIL_G, isFuelRow, offersKcal } from "~~/shared/fuel";
// the same worthiness + identity rules the capture path runs, so "already banked"
// below can only ever claim what capture would actually take (statically imported
// like useGearList's own vaultNormKey — this module is in the editor graph already)
import { isKitWorthy, isVaultWorthy, vaultNormKey, vaultRowFields } from "~~/shared/vault";
import { motionIsInstant } from "~/plugins/inputModality.client";

// The editor's row — editable by default, a checklist row in packing mode. A nested item
// renders the SAME row with `nested` set (indented, one level only). The share view
// (/s) renders ReadonlyItemRow instead, so this component (and the editor graph it
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
// the editor's toast (ROW_FLASH, above); silent where nothing provides one
const flash = inject(ROW_FLASH, () => {});
const c = useGearList();
// two jobs for the vault button: telling "your vault is unreachable" from "you
// don't have one" when banking a row fails (the button is offered signed out too,
// since signing in is a reasonable answer to pressing it), and gating vaultCovered
// below — signed out, nothing reaches a vault automatically, so no row may claim
// it's already there
const { hasVault, vaultKnown } = useVaultAccess();
// ...and the one fact neither of those carries: what My Gear actually holds of
// THIS LIST's gear, and at what weight. It belongs to the open list, which asked
// once when it opened (useGearList.askVaultGear) — so a 150-row list reads two
// refs rather than holding a cache of its own.
const { vaultGear, vaultGearAsked, vaultGearSettled } = c;

// The two mount latches (each row face mounts the first time its mode is entered and
// then stays, CSS-hidden elsewhere) and the mode itself, for event handlers only —
// neither `mode` nor anything else here changes per switch in a way this row renders.
const { mode: editorMode, everEdit, everPacked } = useEditorMode();

// ---- nesting: children render as the SAME row, indented under this one ----
// A row with children is a "group": its weight column shows the group total (own +
// children, read-only, like a folder subtotal); the children carry the real editable
// weights. Nesting is one level, so a nested row never renders its own children.
const childrenByParent = inject(CHILDREN_BY_PARENT)!;
// the rows whose variant belongs beside the name (VARIANT_SHOWN, above): this row
// reads one membership, so the set changing under it re-renders nothing unless its
// own answer flips
const variantShownIds = inject(VARIANT_SHOWN)!;
const children = computed(() =>
  props.nested ? NO_ITEMS : (childrenByParent.value.get(props.item.id) ?? NO_ITEMS),
);
const isParent = computed(() => children.value.length > 0);
// A group holding NOTHING of its own — where the row's per-unit cells stand down (the
// count and the two class marks). One predicate in shared/weights so this row, the
// checklist face below it and the read views can't drift on which rows are bare; and
// the reason it isn't simply `isParent` is that a group carrying a real weight or real
// calories still has something for those controls to act on, and this app doesn't hide
// a number it can't also correct. See isBareGroup.
const bareGroup = computed(() => isBareGroup(props.item, isParent.value));
// collapse a nested group — hide/show its children, persisted per item id (pure UI
// state, never sent to the server), mirroring the folder collapse. Only meaningful on
// a parent row. It applies in PACKING mode too (the checklist face draws its own
// chevron), and the group's tick rolls the folded rows up deliberately: they are your
// own rows, put away by you, which is not the case the filter guards against.
// Adopted on MOUNT rather than at setup (usePersistedCollapse.useFor), so the first
// paint is the same expanded one the server drew.
const { collapsed: nestCollapsed, toggle: toggleNest } = nestCollapse.useFor(() => props.item.id);
// the packing row's weight — same rule as the read views (ReadonlyItemRow): a
// group shows its total (own + children), a leaf its own line
const rowWeightMg = computed(() => groupLineMg(props.item, children.value));
// ---- the packing tick ----
// What this row's box stands for, and what pressing it writes — both resolved by
// shared/packing, which holds the whole rule and the reasoning behind it. In short: a
// leaf is itself, a bare group is its children, and a group carrying a weight or
// calories of its own is both. "none" is a bare group whose children the person filter
// has all hidden: it stands for no row at all, so the template disables it rather than
// letting a press land on a flag nothing draws.
//
// THE FILTER, which no other part of this row reads. usePersonFilter's design is that
// flipping a chip is one attribute write that re-renders nothing — and this computed is
// the documented exception to it (that file's header names this one). It is a cheap
// exception: `tick` is a STRING, so a flip recomputes ~150 short walks and re-renders
// only the rows whose state actually changed. Reading the filter is not optional here.
// A box that counted children the filter is hiding would read "mixed" over a group
// whose every visible row was ticked, and a press on it would pack rows belonging to
// somebody the person looking at the list didn't ask about.
const personFilter = usePersonFilter();
const tick = computed(() => tickState(props.item, children.value, personFilter.selected.value));
// One op per row, like "Clear checks" (GearEditor): the queue, offline replay and the
// change summary ("Checked off 6 items") all apply unchanged. Rows already in the new
// state are skipped, so a press on a half-packed group writes only the other half —
// and a press always writes something: a box reads checked only while every row it
// stands for is packed, and clear or mixed only while at least one isn't.
function onTick(e: Event) {
  const el = e.target as HTMLInputElement;
  const packed = el.checked;
  for (const it of tickRows(props.item, children.value, personFilter.selected.value))
    if (!!it.packed !== packed) c.updateItem(it.id, { packed });
  // ...then put the ELEMENT back in step with the model, by hand.
  //
  // `checked` and `indeterminate` are DOM properties, and a native click writes both
  // (flipping one, clearing the other) before this handler runs. Vue's own patch only
  // fires when the BOUND value changes — `next !== prev` — so any press that leaves
  // `tick` where it was leaves the browser's write standing instead: the dash gone and
  // a full tick painted over a group that is still half packed. `:checked` has no
  // re-sync of its own (v-model's is a `beforeUpdate` hook this binding doesn't get).
  // It takes a dropped write to reach — a child removed by a collaborator between the
  // render and the click, which applyOps then no-ops — but the fix is two lines and the
  // failure is a checklist lying about what is in the bag.
  el.checked = tick.value === "checked";
  el.indeterminate = tick.value === "mixed";
}
// Indent (nest under the row above): only a top-level, childless row with a row
// above it in DISPLAY order can (keeps nesting one level deep; prevId comes from
// the parent's v-for, so a sorted folder nests under the row you see, not the
// sortOrder-previous one). Outdent is offered to any child.
const canIndent = computed(() => !props.nested && !isParent.value && props.prevId != null);

// drag-to-reorder (editable rows only)
const dnd = useItemDnd();
// the grip's tooltip teaches the copy gesture, so it has to name the key this
// keyboard actually has — "⌥" on a Mac (see app/utils/platform)
const altLabel = altKeyLabel();
const isDragging = computed(() => dnd.dragId.value === props.item.id);
// (A drag with Alt held COPIES rather than moves. The row still lifts and follows the
// pointer — a gesture whose held object stayed put would read as broken — and the
// in-flight signal is the cursor, which GearEditor puts on the editing surface rather
// than here: this row is pointer-events:none while lifted, so it cannot set one.)
// the group's collapse clip (overflow:hidden on .nest-block, needed for the 1fr↔0fr
// slide) would crop a lifted drag row, so it lifts while any drag is in flight —
// mirrors the folder's dragpass lift. (A child's open overlay lifts it too, in CSS: see
// .nest-block:has(.popover) below.) Never when collapsed: hidden children can't be dragged.
const nestLifted = computed(() => !nestCollapsed.value && dnd.dragId.value != null);
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
  const step = gripStep(e);
  if (!step) return;
  const parentId = props.item.parentId ?? null;
  const sibs = siblingItems(props.list.items, props.item.folderId, parentId).sort(bySortOrder);
  const i = sibs.findIndex((s) => s.id === props.item.id);
  if (i < 0) return;
  if (step < 0) {
    const above = sibs[i - 1];
    if (above) c.moveItem(props.item.id, props.item.folderId, above.id, parentId);
  } else if (sibs[i + 1]) {
    // one slot down = insert before the row after next (none = append)
    c.moveItem(props.item.id, props.item.folderId, sibs[i + 2]?.id ?? null, parentId);
  }
  refocusGrip(e);
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
  if (leaving.value) return; // already folding away; its finish discards
  if (!(c.isEmptyRow(props.item.id) && foldAway())) c.discardEmpty(props.item.id);
}

// THE REVERSE OF "ADD AN ITEM" (FolderRows: the link becomes the field). A blank row
// you click away from folds back into the link instead of vanishing: its box
// collapses under the field on the step spring, exactly the arrival run backwards
// (grid rows 1fr→0fr, padding-bottom to 0, the field itself never moving), the
// controls fade on the fade spring, and the link — kept out of sight by FolderRows
// while .is-leaving holds — stands exactly where the field was when the row goes.
// Web Animations rather than a leave transition because removal is a dispatch that
// splices the row before the render; this runs first and dispatches on its finish.
// The animations are left filling forward: a cancel before the dispatch would show
// the full row for the frame between the two. Catchable: focus coming back mid-fold
// reverses it from the frame it is at (onRowFocusIn), and nothing is discarded.
// Not when focus left by the KEYBOARD (Tab or Escape out of a blank row) or with
// reduced motion: the row goes in one frame, the way it always did without a fold —
// a Web Animation is the one kind of motion atoms/modality.scss can't reach.
const leaving = ref(false);
let leaveAnims: Animation[] = [];
function foldAway(): boolean {
  const wrap = wrapRef.value;
  if (!wrap || !import.meta.client || motionIsInstant()) return false;
  const step = springCss("step");
  const fade = springCss("fade");
  // the cluster's BOXED parts: .item__meta and the .item__trail inside it are both
  // display:contents (no box, so no opacity) — the marks and actions sit under the
  // second one. The same selector FolderRows' arrival fades.
  const controls = [...wrap.querySelectorAll<HTMLElement>(".item__meta > :not(.item__trail), .item__meta > .item__trail > *")];
  wrap.style.display = "grid";
  wrap.style.gridTemplateRows = "1fr";
  wrap.style.contentVisibility = "visible"; // its paint containment would clip the field
  for (const k of wrap.children) (k as HTMLElement).style.minHeight = "0";
  try {
    const box = wrap.animate(
      [{ gridTemplateRows: "1fr", paddingBottom: getComputedStyle(wrap).paddingBottom }, { gridTemplateRows: "0fr", paddingBottom: "0px" }],
      { duration: step.duration, easing: step.easing, fill: "forwards" },
    );
    leaveAnims = [box, ...controls.map((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade.duration, easing: fade.easing, fill: "forwards" }))];
    leaving.value = true;
    box.finished.then(
      () => {
        if (!leaving.value) return; // reversed: a refocus took it back
        leaving.value = false;
        if (c.isEmptyRow(props.item.id)) c.discardEmpty(props.item.id);
        else unfold(); // filled in meanwhile (a paste, a vault pick): back to a row
      },
      () => {},
    );
    return true;
  } catch {
    unfold();
    return false;
  }
}
function unfold() {
  for (const a of leaveAnims) a.cancel();
  leaveAnims = [];
  const wrap = wrapRef.value;
  if (!wrap) return;
  wrap.style.display = "";
  wrap.style.gridTemplateRows = "";
  wrap.style.contentVisibility = "";
  for (const k of wrap.children) (k as HTMLElement).style.minHeight = "";
}
function onRowFocusIn() {
  if (!leaving.value) return;
  leaving.value = false;
  if (motionIsInstant()) return unfold(); // Shift+Tab back in: the row is simply there again
  const anims = leaveAnims;
  for (const a of anims) a.reverse();
  Promise.all(anims.map((a) => a.finished)).then(
    () => {
      if (!leaving.value && leaveAnims === anims) unfold();
    },
    () => {},
  );
}
onBeforeUnmount(() => {
  // A row that goes mid-fold (a link followed, a filter that hides it) never reaches the
  // fold's finish, which is what discards it: do that here, or the blank row stays saved.
  if (leaving.value && c.isEmptyRow(props.item.id)) c.discardEmpty(props.item.id);
  for (const a of leaveAnims) a.cancel();
});

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
// A GROUP row resolves the same way, though nothing was ever typed on it: its figure
// is a sum of children that may each read differently, so no typed unit stands behind
// it — but a stuff sack totalling 0.59 lb is a thing you may well want to see in
// ounces, and the list's unit used to be the only answer on offer. So `entryUnit` on a
// parent means what the picker beside it says: the unit its total is SHOWN in. Nothing
// else reads it there — the weight cell is read-only on a group, and the CSV writes a
// unit only for a row carrying a weight of its own — so the one field can carry both
// senses without either leaking into the other.
// The editable name field shows "Brand Model" and NOT the variant. The variant has its
// own field in the sub-line below (variantShown / onVariant): a pick fills it, a free
// rename clears it along with the link (onNameCommit), and a person can type one. Beside
// the product you know your own gear by it read as noise on every row, so the checklist
// face's sub-line carries it only where it tells two rows apart (variantOnRow). ItemInput
// puts the same "Brand Model" in the box after a pick, and that pairing is load-bearing:
// its blur commit compares the box against THIS value, and a box still holding the
// variant would read as a rename and unlink the row it had just linked.
// The variant on the checklist face's sub-line: only where the list holds the same
// product in another variant too (shared/variantShown, one pass per snapshot). On the
// SUB-line, where the editor puts it, so the name line reads the same on every face
// (Ryan, 2026-09-12: the checklist "expresses the variant on a different line").
const variantOnRow = computed(() => variantShownIds.value.has(props.item.id));

// the picture a consumable row's mark wears, and water's fixed one: the droplet, the
// fuel can, or the cookie — the same one the share view and /gear draw for the row
// (consumableIcon is the one rule all three read). What else a fuel name decides — no
// calorie field — is kcalOffered below, reading shared/fuel for itself.
const consumableGlyph = computed(() => consumableIcon(props.item));

// renaming in place via the same autocomplete: a catalog pick re-links + fills the
// weight; a free-text rename just updates the name (or its trailing weight).
// A multi-line paste into the name box (ItemInput.onPaste). The first line is this
// row's, applied here through the same onNameCommit a typed name takes, AFTER the row
// as it stands is copied off, so the paste's undo can give it back: the rows the paste
// made are removed and this one is restored, name, link, weight and all, which is what
// "undo a paste" means when the paste landed over something (ItemInput.onPaste says
// why the line arrives un-applied). The rest become rows after this one; the last of
// them is where Enter's next blank row goes (onAdvance), since that is the end of the
// list just pasted, not the middle of it.
const advanceAfter = ref<string | null>(null);
function onPasteRows({ first, rest }: { first: NameCommit | null; rest: string[] }) {
  const before = { ...props.item };
  if (first) onNameCommit(first);
  advanceAfter.value = c.pasteItemsAfter(props.item.id, rest, before) || null;
}
// Enter opens a blank row below: below the rows a paste just made, when there was
// one and they are still there; else directly below this row (todo-list entry)
function onAdvance() {
  const after = advanceAfter.value;
  const anchor = after && props.list.items.some((i) => i.id === after) ? after : props.item.id;
  advanceAfter.value = null;
  c.addBlankItemAfter(anchor);
}
function onNameCommit(p: NameCommit) {
  const patch: ItemPatch = { name: p.name };
  if (p.fromVault || p.own) {
    // Pulled from your own vault (or a size of your own on a catalog product, which
    // lands the same way: see NameCommit.own). It may carry a catalog link (it does when the
    // gear first arrived as a catalog pick), and that link is kept for provenance
    // — but every VALUE here is yours, not the catalog's, so each is marked
    // overridden. Without that, live-resolve would quietly rewrite your measured
    // weight and your chosen name back to the catalog's on the next snapshot,
    // which would make the vault pointless for exactly the gear it matters most
    // for: the item whose spec weight is wrong. Which fields, and how, is the one rule
    // the gear pane's add uses too (vaultRowFields).
    const fields = vaultRowFields(p);
    // a pick REPLACES the piece the row was: a maker, size or catalog link the new one
    // doesn't have is cleared, where the shared rule leaves an absent field alone
    Object.assign(patch, fields, { brand: fields.brand ?? "", variant: fields.variant ?? "", catalogItemId: fields.catalogItemId ?? null });
    // a gear type typed on this row is the row's own, and outlives the pick
    if (props.item.commonNameOverridden) {
      delete patch.commonName;
      delete patch.commonNameOverridden;
    }
    // A size of your own has no weight anyone has cited, and the one the row held belongs
    // to what it was before (another product, or another size of this one): left in
    // place, a quilt's 560 g would sit on the jacket that replaced it. Not weighed yet
    // is 0, the state the weight field asks to fill (focus goes there, below).
    if (p.own) {
      patch.unitWeightMg = 0;
      patch.entryUnit = null;
    }
    // catalogWeightMgAtLink is deliberately NOT set: it's the baseline for the
    // "the catalog's weight changed" nudge, and your own weight is not that
    // baseline — stamping it here would compare the catalog against you. The row
    // ends up with no baseline at all, not the PREVIOUS product's: the reducer
    // drops a baseline whose link has moved (shared/ops, updateItem).
  } else if (p.catalogItemId != null) {
    // a catalog pick: every value is the product's (pickFromCatalog, the rule an import,
    // a paste and the connector share), except a gear type the person typed or emptied,
    // which is theirs and outlives the pick (keptGearType). The class is left to the
    // classification line below, which reads the one the pick arrived with.
    const product = {
      id: p.catalogItemId,
      name: p.name,
      brand: p.brand ?? null,
      variant: p.variant ?? null,
      weightMg: p.weightMg ?? 0,
      commonName: p.commonName ?? null,
      kcal: p.kcal ?? null,
      categoryHint: null,
    };
    const own = { commonName: keptGearType(props.item) };
    Object.assign(patch, pickFromCatalog(product, own, { folderId: props.item.folderId, folders: props.list.folders }));
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
      // a water volume is the row's whole amount (foldWaterQty, shared/ops): picking
      // "Water · 1 L" on a row stepped to 3 is 1 L, not a count multiplying it to 3
      if (isWaterName(p.name)) patch.qty = 1;
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
  // water and catalog food arrive as consumable. Through storedClassification, not a bare
  // `=== "base" ? null`: null means "follow the folder", so an explicit base pick
  // landing in a worn/consumable folder has to be pinned or it silently inherits.
  if (p.classification !== undefined)
    patch.classification = storedClassification(p.classification, props.item.folderId, props.list.folders);
  // A GROUP TAKES NO WEIGHT FROM ITS NAME. Every branch above can carry one — a catalog
  // pick, a vault pick, a water volume, a trailing "540 g" on free text — and a parent's
  // weight cell is read-only and shows its children's total, so a weight landing here
  // would be counted in every rollup, printed on no row and editable in no field: the
  // one state the wrap exists to prevent, arriving through the name box instead of
  // through a nest. `:suggest` below takes away the MENU, which is the affordance; this
  // is the guard, at the single point every branch passes through, matching onWeight and
  // onWeightStep, which have refused a parent all along. Renaming still works — only the
  // number is dropped.
  if (isParent.value) {
    delete patch.unitWeightMg;
    delete patch.weightOverridden;
    delete patch.catalogWeightMgAtLink;
    delete patch.entryUnit; // set only alongside a weight in the branches above
  }
  c.updateItem(props.item.id, patch);
  // a size of your own has no weight yet, and it is the one thing the row still needs
  if (p.own && !isParent.value)
    nextTick(() => wrapRef.value?.querySelector<HTMLInputElement>(".item__weight .field")?.focus());
}

// the sub-line: the gear type (common name) and the note. Each shows as an editable
// field whenever it holds a value (a catalog pick pre-fills the gear type), and both
// empty fields appear while the product name is being edited, so a row typed by hand
// has a visible place to put either — there is no separate "add a note" control. Each
// is cleared by emptying its own input.
const noteRef = useTemplateRef<HTMLTextAreaElement>("noteRef");
// Set by focus landing anywhere in the name cell; held until focus leaves the ROW (so
// tabbing on to the fields themselves, or to qty/weight, doesn't yank them away
// mid-edit), then cleared by onRowBlur. An empty field just folds back up — nothing is
// written by revealing it.
const nameEditing = ref(false);
// Landing in ANY of the row's text fields offers the sub-line, not only the name box:
// a person editing the weight is editing the row, and the gear type, size and note are
// one tab away from there too (Ryan, 2026-09-12: "clicking into any text field on the
// row should probably expose all rows"). Fields only: the row's buttons and menus take
// focus as well, and opening the ⋯ menu is not editing.
function onFieldFocus(e: FocusEvent) {
  if ((e.target as HTMLElement | null)?.matches?.("input, textarea")) nameEditing.value = true;
}
// A GROUP's own name is already the everyday label — that's where it comes from
// (useGearList.containerFor lifts the wrapped product's common name up to be the
// group's name), so offering a group a second one is circular. A parent therefore
// never opens the EMPTY field. A value it already carries still shows, so a row
// that acquired one before it became a group can still be read and cleared —
// never a stored value with no field to edit it.
const cnameShown = computed(() => !!props.item.commonName || (nameEditing.value && !isParent.value));
const noteShown = computed(() => !!props.item.description || nameEditing.value);
// The variant, as a quiet field beside the gear type: the catalog's "Long, 18F" or
// "Men's Medium" after a pick, or whatever the person types (Ryan, 2026-09-12: keep the
// gear type and the variant "available to people to add to"). It came off the name line
// (editableName) and this is where it went, so a picked size is still one glance away.
// Opens with the gear type on the same rule: a stored value, or a name box being edited
// on a leaf. A group opens no empty field, as with the gear type.
const variantShown = computed(() => !!props.item.variant || (nameEditing.value && !isParent.value));
// the sub-line block shows when any of the three does
const subShown = computed(() => cnameShown.value || noteShown.value || variantShown.value);

// The note grows to fit its text. `field-sizing: content` (in the stylesheet) does it
// natively; this is the fallback for the engines without it, and it runs ONLY there —
// an explicit inline height overrides content sizing, so running both would replace
// the free native path with a forced layout flush per keystroke. Collapse to auto
// first, then take scrollHeight: without the reset the box can only ever grow, since
// the scrollHeight of an already-tall textarea includes the empty space. (The same
// pair ListHead gives the list title, which is the same problem at page scale.)
//
// NO window-resize refit, which is the one part that does NOT copy across. The title
// is a singleton; this component mounts once per item, so a listener each is exactly
// the always-on-per-row cost useMenuDismiss exists to avoid — a 150-row list would
// carry 150 of them to re-measure notes nobody is looking at. A viewport that changes
// under a note leaves it a line of slack until the next keystroke; the listeners would
// cost every resize frame on every list.
const fitNote = () => fitTextarea(noteRef.value);
// Both triggers, because either can put text in front of a box that hasn't measured
// it: a note arriving from outside (the list loading in, a collaborator's edit on the
// poll), and the field being revealed at all — it is v-if'd, so a stored note's first
// measurable moment is the tick after `noteShown` turns true.
if (needsTextareaFit) {
  watch([() => props.item.description, noteShown], () => nextTick(fitNote), { immediate: true });
}

const {
  editableName,
  effClass,
  groupWeight,
  isWater,
  litersDisplay,
  onCommonName,
  onNote,
  onQty,
  onRowUnit,
  onVariant,
  onWaterLiters,
  onWeight,
  onWeightFocus,
  onWeightKeydown,
  onWeightStep,
  qtyFieldRef,
  qtyPopping,
  rowKcal,
  rowUnit,
  stepQty,
  weightDisplay,
} = useItemRowFields({
  item: toRef(props, "item"),
  list: toRef(props, "list"),
  children,
  isParent,
  onAdvance,
  fitNote,
});

const { activeSplit, classAria, classTitle, isConsumable, isWorn, pickClass, rowClass, setWornCount, splitOffered, wornCount } =
  useItemRowClassification({
    item: toRef(props, "item"),
    list: toRef(props, "list"),
    effectiveClass: effClass,
  });

// ---- the row's popovers ----
// One-at-a-time across the whole list (useItemMenu's singleton), and the folder
// lifts its collapse clip while any is open (atoms/folder.scss). The singleton holds ONE
// open id, so every popover a row can raise is namespaced off the row id
// (`<id>:menu`, `<id>:class`, …). That's what makes them mutually exclusive for free
// — opening the calorie popover closes the ⋯ menu, on this row or any other, with
// no cross-wiring between them.
//
// The three MENUS (carrier, nesting, the mobile ⋯ overflow) are <ItemRowMenu>s in
// the template — one component for the chrome and the open/close contract, with
// only their entries written here. The classification DIALOG below stays in
// this file: it holds a choice and a field rather than a list of actions.
const menu = useItemMenu();

// ---- the class popover ----
// ONE mark a row, and one card behind it: the choice of class (base, worn, consumable)
// and under it the one detail that only makes sense for the class chosen — worn's how
// many of the count, consumable's calories and cooking. It was two toggles with a card
// each, side by side, which read as two independent switches over a field that holds
// ONE value: each card had to say "Turns the other off" before its switch, and a row
// that could not be worn kept an invisible second slot so the first stayed in column.
//
// Namespaced off the row id like the menus, so the singleton's single openId makes
// every popover on every row mutually exclusive with no cross-wiring.
//
// Placement is measured per open (useMenuPlacement, in its `center` mode). Flip ABOVE
// the trigger when there isn't room below: a list is long and its last rows sit at
// the viewport floor, where a below-anchored popover opens off-screen — the one
// place the feature is needed is the one place it would be unreachable. Sideways it
// sits UNDER THE MIDDLE OF THE RING and slides only as far as the window makes it,
// as the row's menus do (ItemRowMenu): it hung off the ring's right edge, which put
// most of the card over the weight it sits beside, and beside a catalog mark whose
// menu centres the two cards opened from different corners (2026-11-27). On a phone
// the ring is mid-row and the slide is what keeps the card on screen, which is the
// job the old `shift` mode did from the trailing edge.
// Tooltip.vue solves the same problem but is built around a hover-driven popup
// teleported to <body>; this popover holds a focusable field and stays in the row.
const classRootRef = useTemplateRef<HTMLElement>("classRootRef");
const classPopRef = useTemplateRef<HTMLElement>("classPopRef");
const isClassOpen = computed(() => menu.openId.value === `${props.item.id}:class`);
const { above: classAbove, shift: classShift, place: placeClass } = useMenuPlacement(classPopRef, { fit: "center" });
// The picture on the mark: what the row counts as. The shirt for worn, and for a
// consumable whichever of the cookie, the fuel can and the droplet consumableIcon picks.
// BASE is the row with nothing set (it is stored as null), so its mark is the empty
// outline of the plate the other two light: a dashed ring. It was the backpack, which
// at this size read as a bin beside the row's own trash can. A shirt and a cookie either
// side of a slash was drawn too (Ryan's idea, 2026-11-25): as two miniatures it read as
// a percent sign among the weights, as two halves it read as nothing.
const classGlyph = computed(() => (rowClass.value === "worn" ? IconFashion : rowClass.value === "consumable" ? consumableGlyph.value : UnsetRingGlyph));

// Whether the card offers the CALORIE field is decided when it opens, and held while it
// is open. The rule reads the row as stored, and two things can change that under an
// open card: clearing the number (the field's own job) and the name committing — a name
// typed and then acted on without leaving the field commits on the focus move the card's
// own field causes. Either would unmount the field with the cursor in it. So an open
// card keeps the field it opened with; the next open reads the row afresh.
// The field is offered only once the row IS consumable, the only state in which the
// number is counted, so offering it sooner would collect a value the totals ignore — and
// not on stove fuel holding no number, whose "calories" are the wrong kind and would
// feed the food plan (offersKcal, shared/fuel, has the whole argument and the exception:
// a fuel row that already carries a value keeps the field, so the count stays clearable).
// Served here rather than given a column: kcal is a fact about food, and food is a
// minority of a minority of rows.
const kcalHeld = ref(false);
// immediate: the menu singleton outlives a row, so a row can mount with its popover
// already open, and must decide (and place the card) then too
watch(
  isClassOpen,
  (open, was) => {
    if (!open) return;
    kcalHeld.value = offersKcal(props.item);
    // on the tick the card mounts — it has no size to measure before that
    nextTick(() => {
      placeClass();
      // On a consumable the card opens with the cursor in the calorie field — that
      // number is what the card is opened for there, so landing anywhere else would
      // make every use a click plus a tab. No focus move on any other row: its controls
      // are a choice and a set of buttons, and pulling focus to the first of those would
      // look like a selection had been made. On an open only: a row that mounts under an
      // open popover takes no focus it didn't have.
      if (was === false) classRootRef.value?.querySelector<HTMLInputElement>(".item__popinput")?.focus();
    });
  },
  { immediate: true },
);
// the choice is a radio group: one tab stop, the arrows move the selection
const { onKey: onClassKey } = useRovingRadio(
  () => CLASS_OPTIONS.length,
  () => CLASS_OPTIONS.findIndex((o) => o.key === rowClass.value),
  (at) => pickClass(CLASS_OPTIONS[at]!.key),
);
const kcalOffered = computed(() => isConsumable.value && (isClassOpen.value ? kcalHeld.value : offersKcal(props.item)));
// Whether the class mark is drawn. `!bareGroup` is the rule (below, at the cell);
// the other three terms are the cases where taking them away would strand something:
//  • WATER — its cell holds a FIXED mark, not a toggle, and that glyph is the only thing
//    on the row saying it is a consumable. Nothing else can restate it, so it stays.
//  • A STORED CLASS — a row marked worn or consumable before it gained children keeps its
//    mark, or the value is set forever with no field to clear it, still exported and
//    still read by unwrapEmptied's guard. Same rule the gear type follows (cnameShown).
//  • AN OPEN POPOVER — the class popover lives INSIDE this cell, and clearing the
//    kcal field is exactly what can turn the row bare, which would unmount the popover
//    the user is typing in.
const classCellShown = computed(
  () => isWater.value || !bareGroup.value || props.item.classification != null || props.item.needsCooking || isClassOpen.value,
);

// The popover GROWS after it is placed: choosing Consumable adds the calorie field, its
// total and the cooking switch, and choosing Worn on a row of several adds the counts.
// `place` runs once, on the short card, so a row near the viewport floor opened its card
// below and then grew it past the bottom of the screen (measured: "Needs cooking" cut off
// at the window edge). Re-placing would flip the card to the other side of its trigger —
// the switch you just pressed jumping the card's whole height from under the pointer. So
// the card stays where it opened and the PAGE gives way, by the least that shows it:
// `nearest` moves nothing when the card already fits, and html's scroll-padding-top
// (reset.scss) keeps it clear of the sticky topbar when a card opened above grows upward.
// Hung on the card's own click and change, not a ResizeObserver: only a press inside the
// card grows it on purpose, and an observer also fired when another device's edit
// resized a card the reader had scrolled away from, pulling the page back to it.
function keepPopInView(e: Event) {
  const pop = e.currentTarget as HTMLElement;
  nextTick(() => {
    if (pop.isConnected) pop.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: motionIsInstant() ? "auto" : "smooth" });
  });
}

// whether the cooking switch is shown: on food that is consumable, not on stove fuel,
// and on a bare group only while it already says it needs cooking, so it can be cleared
const cookingOffered = computed(() => isConsumable.value && !isFuelRow(props.item) && (!bareGroup.value || !!props.item.needsCooking));

// Open or close it; what follows an open (placing the card, the kcal field's focus) is
// the watcher's above.
const toggleClass = () => menu.toggle(`${props.item.id}:class`, classRootRef.value);
// The typed worn count. Anything that isn't a number leaves the row alone, and the field
// is put back to what the row holds either way — setWornCount clamps to the line, so
// "99" on a row of 40 must read 40 afterwards, and a figure that changed nothing would
// otherwise sit in the box contradicting the line above it.
function onWornCount(e: Event) {
  const el = e.target as HTMLInputElement;
  const n = el.value.trim() === "" ? NaN : Number(el.value);
  if (Number.isFinite(n)) setWornCount(n);
  el.value = String(wornCount.value);
}
function onKcal(e: Event) {
  const el = e.target as HTMLInputElement;
  // "" (and anything unparseable) clears — the reducer treats a non-number as
  // absent rather than 0, so an emptied field means "not filled in", not "zero
  // calories". Resync afterwards so a rejected entry doesn't linger in the box.
  // parseKcal reads a thousands separator, as My Gear's field does: the line below
  // this field prints "2,700 kcal", and a number typed back that way must not clear.
  c.updateItem(props.item.id, { kcal: parseKcal(el.value) });
  el.value = props.item.kcal ? String(props.item.kcal) : "";
}
// ---- nesting ----
// The two actions a row can offer, resolved to whichever apply. Same table-drives-
// both-markup-and-dispatch shape the editor's ⋯ menu uses, so an action can't exist
// in one without the other.
// Each carries its own glyph, and they are the three the trigger above collapsed
// (list-plus, indent, outdent). What made those unreadable was standing alone at 16px
// with nothing to say which was which; in a menu each sits beside its own label, so
// the glyph is a shape to aim at rather than the only thing naming the action.
const nestActions = computed(() => {
  const acts: { label: string; icon: IconNode; run: () => void }[] = [];
  // a nested row can't nest further, and a row that already HAS children uses its
  // own ever-present "Add an item" instead
  if (!props.nested && !isParent.value) acts.push({ label: "Add an item under this one", icon: IconListAdd, run: () => c.addChild(props.item.id) });
  // The glyphs go by the way the ARROW points, which is the way the row travels, and
  // not by their names, which say only which side the arrow sits on: IndentLeft's is on
  // the left pointing right, the push into an indent; IndentRight's is on the right
  // pointing left. Picked by name they were crossed, "Move out" wearing the arrow in.
  if (props.nested) acts.push({ label: "Move out of the group", icon: IconTextIndentRight, run: () => c.unnest(props.item.id) });
  else if (canIndent.value)
    acts.push({ label: "Move under the item above", icon: IconTextIndentLeft, run: () => c.nestItem(props.item.id, props.prevId!) });
  return acts;
});

// ---- carried by (lists with people only) ----
// Who takes this row. A menu hung off its own ghost trigger (the nesting menu's
// shape, placement flip included) rather than a third slot in item__classcell —
// that cell's width is a track the whole page's rows share, and most lists never
// name anyone. The trigger only exists once the list has people; assigned, it
// swaps its glyph for the carrier's own .swatch dot (the vault button's
// state-swap move) — colour stays in a dot, chrome stays foreground, and the dot
// carries the state at a contrast a tinted glyph never met.
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
// A GROUP is worthy as a KIT — the one way a container is gear, and the deliberate
// one: pressed, the group and its children go to My Gear as a set (useVault's
// captureGroup), which the automatic path never does for a heading.
const vaultWorthy = computed(() =>
  isParent.value ? isKitWorthy(props.item, children.value) : isVaultWorthy(props.item, false),
);
const vaultKey = computed(() => vaultNormKey(props.item.brand, props.item.name, props.item.variant));
const vaultCovered = computed(() => {
  // Signed out there is no vault, so nothing can be in one and every worthy row
  // keeps its button — pressing it is how you find that out ("Sign in to keep
  // your gear"). NOT `!hasVault` alone: that ref is also false for the moment
  // before /api/auth/me answers, and reading the two as one put the button on
  // every worthy row of every covered list for the length of that round trip.
  //
  // FIRST, ahead of the wait below, because it makes the wait pointless: there is
  // no answer coming that could change it. Behind the wait, a signed-out visitor
  // — most of them — typed a row and watched its button arrive most of a second
  // late, once a debounced ask had confirmed the nothing we already knew.
  if (vaultKnown.value && !hasVault.value) return false;
  // Has the vault been ASKED about this row's gear? An unanswered key and a key
  // the vault doesn't have are the same absence from the Map, and rendering the
  // second as the first is the flash PR #239 took out of the signed-in first
  // paint. This is the only wait, and it is bounded by construction: the ask
  // settles even when it fails, times out, or is skipped for a visitor with no
  // account (see askVaultGear), so there is no state where it never answers.
  if (!vaultGearAsked.value.has(vaultKey.value)) return true;
  // A group is covered when My Gear holds it AS A KIT — not when it holds a piece
  // of the same name, which is exactly what pressing the group's save turns into
  // the set. And never by the automatic path below: that path captures a group's
  // children and never the group, so a kit is only ever made by this press.
  if (isParent.value) return c.vaultKits.value.has(vaultKey.value);
  // THE TRUTHFUL TEST, and the one this button spent three attempts without: My
  // Gear either has this piece of gear or it doesn't. It holds however the row got
  // there — a list on another device, an import, a hand-typed row on /gear — and
  // it does not care what this list's capture answer happens to be.
  //
  // Held gear still isn't covered while the row carries a weight the vault would
  // take: a press sends the incoming weight as a deliberate replacement, so
  // correcting one and pressing save does something. Membership alone made the
  // button leave on the first press and never come back, so a weight fixed
  // afterwards could not be pushed from that list at all. `null` is a PINNED
  // weight — you fixed it by hand on /gear and no capture may argue with it — and
  // a row with no weight sends nothing (the upsert ignores a zero), so both are
  // covered.
  if (vaultGear.value.has(vaultKey.value)) {
    const held = vaultGear.value.get(vaultKey.value);
    const mine = Math.max(0, Math.round(props.item.unitWeightMg));
    if (held === null || mine === 0 || held === mine) return true;
    // Held at a DIFFERENT weight. The automatic path below only fills a missing
    // vault weight (PR #392: a list is a record of a trip, My Gear is the current
    // kit), so on a covered list it will leave this one exactly as it is — and
    // reading the list's answer as coverage here hid the button on the one row
    // where pressing it is the only act that can move the vault's figure. A held
    // zero is the one figure the automatic path WOULD fill, so that case still
    // falls through to the list's answer.
    if (held !== undefined && held > 0) return false;
  }
  // Not banked yet, but about to be: the automatic path takes this list's gear on
  // the next pause, so offering to do it by hand is offering to do what's already
  // happening. Fail either gate and the worthy row keeps its button, because
  // pressing it is then the only way the row gets banked.
  return c.vaultAuto.value && vaultWorthy.value && !c.vaultDeclined.value.has(vaultKey.value);
});
const vaultSave = ref<"idle" | "saving" | "saved">("idle");
const vaultSaved = computed(() => vaultSave.value === "saved");
const vaultLabel = computed(() =>
  isParent.value
    ? vaultSaved.value ? "Saved to My Gear as a kit" : "Save to My Gear as a kit"
    : vaultSaved.value ? "Saved to My Gear" : "Save to My Gear",
);
/** Does this row offer the save affordance at all — the inline icon and the ⋯
 *  entry, which must agree.
 *
 *  `vaultSaved` overrides coverage on purpose: the tick IS the feedback for a
 *  press, and a press is the very thing that makes the row covered (the key it
 *  banks lands in vaultKeys immediately). Without this the button answered a
 *  click by vanishing, which reads as the click having gone nowhere. */
const vaultOffered = computed(
  () => vaultWorthy.value && (vaultSaved.value || !vaultCovered.value),
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
  vaultGearSettled,
  // Disarms on the way DOWN as well. The list's answer returns to unsettled on
  // every session change (the controller re-asks, because an answer about the
  // last account is not an answer about this one) — so an arm-only latch let an
  // in-page sign-in take every worthy row through covered and back, playing the
  // whole list's shine at once. That is the same page-load burst this exists to
  // prevent, reached by the most ordinary route into the feature.
  (settled) => (settled ? nextTick(() => (vaultRevealArmed.value = true)) : (vaultRevealArmed.value = false)),
  { immediate: true },
);
async function onSaveToVault() {
  // a covered row renders no button, but coverage can flip mid-press (the chooser
  // and the vault answer live outside the row) — the covered guard makes that
  // beat a no-op instead of a save the automatic path already made
  if (vaultSave.value !== "idle" || vaultCovered.value) return;
  vaultSave.value = "saving";
  const asked = savedAs();
  const result = await c.saveItemToVault(props.item.id);
  // renamed or re-weighed while it was out: what got banked is the gear as it WAS, so
  // the tick would speak for gear the vault doesn't hold
  vaultSave.value = result === "saved" && savedAs() === asked ? "saved" : "idle";
  if (result === "saved") return;
  flash(
    result === "unworthy"
      ? isParent.value
        ? "Name the group and weigh the items under it first"
        : "Give the item a name and a weight first"
      // One level deep: a piece that is already some kit's part can't hold parts of
      // its own, and the group would have made it one.
      : result === "nested"
        ? "This is already in a kit in My Gear, so it can’t be a kit itself"
      // You removed this gear on /gear, and capture never resurrects a tombstone
      // — so "try again in a moment" would be a lie and a loop. Say where the way
      // back is: adding the piece again there lifts the tombstone (addVaultItems).
      // (It named a removed-gear list /gear no longer has.)
      : result === "removed"
        ? "You removed this from My Gear. Add it again there to bring it back."
        // ...and a vault with no room is NOT that: there is nothing removed to bring
        // back, so the message above would send you looking forever.
        : result === "full"
        ? "My Gear is full. Remove something there to make room."
        // the vault belongs to an account, so signed out there is nowhere to put it.
        // Naming that is the difference between a dead button and a next step.
        : hasVault.value
          ? "Couldn’t reach My Gear. Check your connection and try again."
          : "Sign in to keep your gear",
  );
}
// a rename or re-weigh makes it a different piece of gear, so the tick stops
// speaking for it and the row can be banked again
function savedAs() {
  return JSON.stringify([props.item.name, props.item.brand, props.item.variant, props.item.unitWeightMg]);
}
watch(savedAs, () => {
  if (vaultSaved.value) vaultSave.value = "idle";
});

// the same actions the inline icons run: the one nesting action that applies to this
// row's state (add-nested / nest-up / un-nest), then the vault save, and last the removal — all inline on a desktop row
// and living only here on a phone (see the mobile block: the trailing cluster is
// ⋯ · grip, because the icons are --touch-target wide there and the line has no room for the
// row's numbers beside more than two of them).
const overflowActions = computed(() => {
  // The nesting entries ARE nestActions — the desktop menu's table, not a second
  // copy of it, so the two seats can't drift on a label. `nest` marks them as the
  // structure edits, which stand down while a person filter is on (CSS off the
  // body attribute — atoms/item.scss; the desktop nest menu hides whole the same
  // way): indent targets the UNFILTERED row above, and a reparent changes what a
  // row inherits, so either can make it vanish from the very view it was touched in.
  // Duplicate LEADS. It is the entry most often reached for, and the only one here
  // that is always available — the nesting pair is conditional (a group row offers no
  // indent, a top-level row no un-nest), so anything after them would open the menu on
  // a different line from one row to the next.
  // Each entry wears the glyph its own inline button wears, the vault's state swap
  // included — the row and the menu should not name one action two ways.
  const acts: { label: string; icon: IconNode; run: () => void; nest?: true }[] = [
    { label: "Duplicate", icon: IconSlideAdd, run: () => c.duplicateItem(props.item.id) },
    ...nestActions.value.map((a) => ({ ...a, nest: true as const })),
  ];
  // Reads its own state, like the inline button's tooltip does — "Saved" is the
  // whole feedback here, since a menu closes on choosing and there's no tick left
  // on screen to see. Same disclosure rule as the inline icon: no entry until the
  // row is gear worth saving, none again once the automatic path has it (it used
  // to stay as a disabled "Already in My Gear" line) — a menu row that can only
  // say "nothing to do" is an action list advertising a non-action.
  if (vaultOffered.value)
    acts.push({ label: vaultLabel.value, icon: vaultSaved.value ? IconCheckmark1Medium : IconSafeSimple, run: onSaveToVault });
  // LAST, the way the destructive icon sat last in the desktop cluster — a menu is a
  // list you read top to bottom, so the one irreversible entry belongs at the end of
  // it rather than under the thumb. "Remove item" here, where the icon's tooltip says
  // "Remove": a menu row arrives without the row in front of it, so it names the thing,
  // and the tooltip drops the noun because it is pinned to the very row it would remove.
  // (The icon's aria-label goes one further and names the row itself, as this menu's
  // trigger does.)
  acts.push({ label: "Remove item", icon: IconTrashCan, run: () => c.removeItem(props.item.id) });
  return acts;
});

// "Fix for everyone": only offered once the user's weight diverges from the
// catalog value they linked — i.e. they think the canonical spec is wrong.
// A plain free-typed override (no catalog link) never nags.
// (Its old `!packed` term moved to CSS with the rest of the mode gating — packing
// hides the whole under-row reveal; atoms/item.scss.)
// "Diverges" is judged as the row READS, in its own unit: grams print no decimals, so
// a catalog 887,340 mg under an imported 887,000 said "Catalog: 887 g" beneath a row
// already reading 887 g. Milligrams the row can't show are not a disagreement.
const correction = useCatalogCorrection();
const showFix = computed(
  () =>
    props.item.catalogItemId != null &&
    props.item.catalogWeightMgAtLink != null &&
    props.item.unitWeightMg > 0 &&
    formatWeight(props.item.unitWeightMg, rowUnit.value) !== formatWeight(props.item.catalogWeightMgAtLink, rowUnit.value),
);
/** the catalog's figure as this row reads, for the mark's tooltip and its first entry */
const catalogShown = computed(() => formatWeight(props.item.catalogWeightMgAtLink ?? 0, rowUnit.value));
function openFix() {
  if (props.item.catalogItemId == null || props.item.catalogWeightMgAtLink == null) return;
  correction.open({
    catalogItemId: props.item.catalogItemId,
    itemName: props.item.name,
    catalogWeightMg: props.item.catalogWeightMgAtLink,
    suggestedMg: props.item.unitWeightMg,
    displayUnit: rowUnit.value,
  });
}
// THE OTHER ANSWER to the same disagreement: the catalog is right and the row is
// wrong, which is the likelier case on a list that was imported (round numbers typed
// into another tool years ago) or weighed by eye. The note only offered to correct the
// catalog for everyone, so agreeing with it meant retyping its figure into the field
// above. This takes it: the row's weight becomes the catalog's, it stops counting as
// an override, and with nothing left to disagree about the note goes.
function useCatalogWeight() {
  const mg = props.item.catalogWeightMgAtLink;
  if (mg == null) return;
  c.updateItem(props.item.id, { unitWeightMg: mg, weightOverridden: false });
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
    :class="{ 'is-dragging': isDragging, 'is-drop-before': isDropBefore, 'is-nest-parent': isNestParent, 'is-leaving': leaving }"
    @focusout="onRowBlur"
    @focusin="onRowFocusIn"
    @click.capture="flushPendingEdit"
  >
    <!-- editing↔packing swap, decided by CSS rather than by this component. Which face
         shows follows the editor body's data-mode (atoms/item.scss); the fade the old
         <Transition> gave the entering face is a CSS animation there, gated on the
         body's is-rowswitching beat so it plays exactly when a switch happens and not
         when a row appears for any other reason. (A row whose faces differ in height
         eases to the new one: GearEditor's row fold.) What this template decides is only
         whether each face has ever been NEEDED (the useEditorMode latches): a face
         mounts the first time its mode is entered and then stays for the page's life,
         display:none'd in the other modes. So a mode switch mounts nothing, unmounts
         nothing, and re-renders nothing here — flipping one body attribute is the
         entire act. The checklist face never mounts for a list that never enters
         packing mode, and a list OPENED in packing builds no edit faces either. -->
      <label v-if="everPacked" class="item-row item item--check" :class="{ 'item--done': tick === 'checked' }">
      <!-- checkbox visuals come from the icon set (Square empty / SquareCheck checked —
           the same glyph as the header's packing toggle, and the two share an identical
           outer square so the swap reads as the tick appearing); the real <input> stays
           on top, invisible but focusable, so behavior + focus stay native -->
      <!-- the shared .check atom (controls.scss); .item__box stays on the input for
           the mobile grid placement below (and the print sheet's colour rule) -->
      <!-- The three states of `tick` (shared/packing, which holds the rule): checked,
           MIXED — the native indeterminate property, which the atom draws as a dash and
           the accessibility tree reads as "mixed" — and clear. Plus "none", a bare group
           whose children a person filter has all hidden: it stands for no row, so the
           box is disabled rather than writing a flag no view would draw. -->
      <span class="check">
        <input
          type="checkbox"
          class="check__box item__box"
          :checked="tick === 'checked'"
          :indeterminate="tick === 'mixed'"
          :disabled="tick === 'none'"
          :aria-label="`Packed: ${editableName || 'item'}`"
          @change="onTick($event)"
        />
        <!-- the row's own glyph size, drawing the same flat 1.5px line -->
        <SvgIcon :icon="IconFormSquare" class="check__icon check__icon--empty" aria-hidden="true" />
        <!-- the dash, on GROUP rows only: a leaf's box stands for exactly one row and
             can never be mixed, and this is a third inline SVG on every row of a long
             checklist. It is also what the atom's own :indeterminate rule keys on to
             know this .check has a mixed face to swap in (controls.scss). -->
        <SvgIcon v-if="isParent" :icon="IconSquareMinus" class="check__icon check__icon--mixed" aria-hidden="true" />
        <SvgIcon :icon="IconSquareCheck" class="check__icon check__icon--check" aria-hidden="true" />
      </span>
      <span class="item__cname" :class="{ 'item__cname--group': isParent }"><ItemName :item="item" :group="isParent" /><span v-if="isParent && rowKcal > 0" class="t-muted item__gkcalinline"> · {{ formatKcal(rowKcal) }} kcal</span><!--
          the carrier, riding the name cell (display-only — this face is a <label>
          over a checkbox, so a control here would toggle the tick). Only their own
          claim is tagged: children of a claimed group inherit silently, or a
          six-item group would say the same name seven times.
       --><span v-if="ownPerson" class="item__carrier"><span class="swatch item__carrier-dot" :style="{ background: personColor(ownPerson) }" aria-hidden="true" /><span class="item__carrier-name">{{ ownPerson.name }}</span></span><NestChevron
          v-if="isParent"
          :collapsed="nestCollapsed"
          :label="item.name || 'group'"
          stop
          @mousedown.prevent
          @toggle="toggleNest"
        /></span>
      <!-- `item__qty--split` widens the amount track for the whole page column when any
           row in the list spells out a worn split ("×12 · 11 worn") — atoms/item.scss.
           `group` empties it on a BARE group, matching the edit row's missing qty cell
           and the read row's: the weight beside it is the group's TOTAL, so a count
           there would be multiplying a figure it is already part of. The widening class
           goes with the label — a group CAN carry a split (qty is not a term in
           isBareGroup), and left on an empty cell it would widen the amount track for
           every row on the page on the strength of a figure nothing prints.
           `hideSingle` blanks a plain "×1", as the share row does and for its reason
           (itemQtyLabel): a column where nearly every cell says the same thing has to
           be read past to find the rows that carry a count. -->
      <span class="t-num t-muted item__cqty" :class="{ 'item__qty--split': activeSplit && !bareGroup }">{{ itemQtyLabel(item, effClass, { hideSingle: true, group: bareGroup }) }}</span>
      <!-- the empty unit slot keeps the zero placeholder in the number's place rather
           than out at the cell's edge — same as the read row's -->
      <span class="t-num item__cweight"><template v-if="rowWeightMg > 0">{{ formatWeight(rowWeightMg, rowUnit, { withUnit: false }) }}<span class="t-muted item__wunit">{{ rowUnit }}</span></template><template v-else>—<span class="item__wunit" /></template></span>
      <!-- the common name — a quiet sub-line under the product name (what you're checking
           off), aligned to the name column past the checkbox; mirrors the read row. The
           variant rides it in the aside voice, where the list holds the product in two
           variants (variantOnRow); the dot goes with the gear type, so a variant alone
           doesn't open with a stray one, as on the edit face's sub-line. -->
      <span v-if="item.commonName || variantOnRow" class="item__csub">{{ item.commonName }}<span v-if="variantOnRow" class="item__cvariant">{{ item.commonName ? " · " : "" }}{{ item.variant }}</span></span>
    </label>

    <div v-if="everEdit" class="item-row item" @focusin="onFieldFocus">
      <!-- editable row (default) -->
      <!-- focusin (it bubbles, unlike focus) rather than binding ItemInput's own input:
           the name cell is the whole "what is this item" affordance, so landing anywhere
           in it offers the gear type + note below (see nameEditing) -->
      <div class="item__name">
        <!-- the name box: the positioned anchor for the autocomplete menu (so it opens
             under the NAME, not under the sub-line below), the group's name·chevron flex
             line, and the focusin target — landing anywhere in it offers the gear type
             + note underneath (nameEditing); focus arriving in those fields does not. -->
        <div class="item__namebox" :class="{ 'item__namebox--group': isParent }">
          <!-- no catalog / My Gear suggestions on a GROUP. A pick stamps the product's
               weight onto the row (onNameCommit), and a group's weight cell is read-only
               and shows the total of its children — so that weight would land where no
               row prints it and no field can edit it: the exact state the wrap exists to
               prevent, arriving through the name box instead of through a nest. A
               container's name is a heading the user writes; the catalog names the
               products, which are its children. Free text is untouched. -->
          <ItemInput
            :unit="rowUnit"
            :initial="editableName"
            :placeholder="isPendingBlank ? 'Add an item' : 'Name of item'"
            :suggest="!isParent"
            :autofocus="isPendingBlank"
            @commit="onNameCommit"
            @advance="onAdvance"
            @paste-rows="onPasteRows"
          />
          <!-- collapse a group of nested items — trails the name like the folder's
               chevron (the name hugs its text so this sits right after it) -->
          <NestChevron
            v-if="isParent"
            :collapsed="nestCollapsed"
            :label="item.name || 'group'"
            @mousedown.prevent
            @toggle="toggleNest"
          />
          <!-- a group that keeps its class marks (#299: one carrying a line of its own)
               reads its calories here, on the name line; a bare group's go in the class
               column below, where its rows' consumable marks are. -->
          <span v-if="isParent && rowKcal > 0" class="t-muted item__gkcalinline" title="Calories in this group">· {{ formatKcal(rowKcal) }} kcal</span>
        </div>
        <!-- sub-line: the gear type (a quiet upright label) and, after it where it fits
             and under it where it doesn't (.item__subfields), the freeform note;
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
              <!-- the gear type and, beside it, the variant: one line, two fields, in the
                   two quiet voices the read row's sub-line uses (an upright label, an
                   italic aside). A wrapping flex line, so the variant sits right after the
                   gear type's text where the fields can size to their content and drops
                   under it where they can't (.item__gtype-line). Either half may be
                   absent: a group opens no empty field for either. The optional inline
                   fields fade independently, while the note below has its own layout reveal:
                   a saved gear type keeps this outer disclosure mounted, so the note still
                   has to slide the row when editing adds it. -->
              <div v-if="cnameShown || variantShown" class="item__gtype-line">
                <!-- the two placeholders are a matched pair — "Name of item" above, "Type of
                     gear" here — so a blank row reads as one short stack. This field used to
                     show examples only ("Tent, Backpack, Quilt…"), relying on the product name
                     above to explain it; on a blank row there is no name above, so the examples
                     read as a second set of name suggestions. A catalog pick fills this field
                     with a real value anyway, which demonstrates the vocabulary better than a
                     placeholder did. The aria-label carries the same noun for screen readers. -->
                <Transition name="reveal-field">
                  <input
                    v-if="cnameShown"
                    class="item__note item__gtype-input"
                    :maxlength="MAX_GEAR_TYPE_LEN"
                    :value="item.commonName ?? ''"
                    placeholder="Type of gear"
                    aria-label="Gear type"
                    list="gear-types"
                    autocorrect="off"
                    spellcheck="true"
                    @change="onCommonName"
                  />
                </Transition>
                <!-- the dot belongs to the pair: it draws only when both fields do, so a
                     variant on its own line (gear type cleared) doesn't open with a
                     stray one. Presentational: the fields carry their own labels. -->
                <Transition name="reveal-field">
                  <span v-if="cnameShown && variantShown" class="item__gtype-dot" aria-hidden="true">·</span>
                </Transition>
                <!-- the variant, a field since 2026-09-12: a pick fills it, a person can
                     type or correct one, and a free rename of the name clears it with the
                     catalog link (onNameCommit). "Size or version", not "Variant": the
                     word is the catalog's, and a person filling this in has a Long, a
                     Men's Medium or a Silpoly in mind (Ryan, 2026-09-12: "variant" is
                     "too industry terminology"). The field's name in code stays
                     `variant`. -->
                <Transition name="reveal-field">
                  <input
                    v-if="variantShown"
                    class="item__note item__variant-input"
                    :maxlength="MAX_VARIANT_LEN"
                    :value="item.variant ?? ''"
                    placeholder="Size or version"
                    aria-label="Size or version"
                    autocorrect="off"
                    spellcheck="false"
                    @change="onVariant"
                  />
                </Transition>
              </div>
              <!-- A TEXTAREA, and the only field on the row that is one. Everything
                   else here holds a value — a name, a count, a weight — and a value
                   that outgrows its box is a bug you fix by typing less. A note is a
                   sentence, and as an <input> a long one simply stopped: an input
                   clips its own value with no ellipsis and no second line, so a note
                   you had written read as ending mid-word with nothing to say it
                   hadn't. It wraps now, which is what the share views have always done
                   with the same text (ReadonlyItemRow's sub-line).
                   Enter still COMMITS rather than opening a line, like every other
                   field in the editor — and it keeps `description` a single line for
                   the CSV and Markdown exports, which would have to quote a newline. -->
              <!-- A row with a stored gear type keeps the OUTER reveal mounted. The note
                   therefore needs its own grid reveal: opacity alone made this second line
                   snap in every production browser when focus offered an empty note. -->
              <Transition name="reveal">
                <div v-if="noteShown" class="reveal reveal--detail">
                  <textarea
                    ref="noteRef"
                    class="item__note"
                    rows="1"
                    :maxlength="MAX_ITEM_NOTE_LEN"
                    :value="item.description ?? ''"
                    placeholder="Add a note"
                    aria-label="Item note"
                    autocorrect="off"
                    spellcheck="true"
                    @input="fitNote"
                    @keydown.enter.prevent="($event.target as HTMLTextAreaElement).blur()"
                    @change="onNote"
                  />
                </div>
              </Transition>
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
             count — so ±1 would be both the wrong step and the wrong idea.
             A BARE GROUP HAS NO CELL HERE AT ALL, the way its weight cell is read-only:
             the column beside it shows the group TOTAL, which the row's own count is
             already inside and which never reached the children — so a "×N" against it
             multiplies a figure with nothing left to multiply. A container the app makes
             holds nothing of its own (containerFor wraps any row that does), so the
             count it hides is a factor on zero; a group that DID arrive carrying a line
             keeps its stepper, because a control removed is a number nobody can see or
             correct. Water keeps its cell either way — that is a volume, not a count,
             and the weight field beside it is read-only on a group, so dropping it would
             leave the row with no editable figure at all. The grid keeps the track
             regardless: the columns are named areas off --item-cols, not the cells that
             sit in them, so the weight column stays put and a parent lines up with its
             children. Two of a kit is a second group: "Duplicate" carries the children. -->
        <!-- No spacer stands in for it on the phone line either. One did, so a group's
             total would start where a sibling row's weight does, but with nothing to
             its left the total read as a broken wrap (Sept 2026, prod). A row's second
             line starts at its own left edge, like every other row's. -->
        <div
          v-if="isWater || !bareGroup"
          class="item__qty"
          :class="{ 'item__qty--step': !isWater, 'item__qty--one': !isWater && item.qty === 1 }"
        >
          <template v-if="isWater">
            <!-- text, not type="number", the way the weight field beside it is: it takes
                 "32 oz" and "500 ml" as well as bare litres (onWaterLiters) -->
            <input
              class="field field--num"
              :value="litersDisplay"
              aria-label="Liters of water"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              @change="onWaterLiters"
            />
            <span class="t-muted item__unit">L</span>
          </template>
          <template v-else>
            <!-- mousedown.prevent for the reason the action icons carry it: on
                 macOS Safari/Firefox a button takes no focus on mousedown, so a
                 press from inside the row's name field blurs the row — and a
                 pristine blank row discards itself on that blur. Holding focus is
                 also what lets you press + three times without the caret leaving
                 the field you were typing in.
                 The names carry the ITEM, like the grip's and the checkbox's do:
                 "One more, button" on its own says nothing about what of.
                 NOT TAB STOPS. The quantity between them is a number field, which
                 steps on ↑ and ↓, so the keyboard already has both presses; as stops
                 they stood between a typed name and its weight, six Tabs apart where
                 four will do. A screen reader's own cursor still reaches them. -->
            <button
              class="btn btn--icon btn--ghost item__qtybtn foreground-quiet"
              type="button"
              :disabled="item.qty <= 1"
              :aria-label="`One fewer ${item.name || 'item'}`"
              tabindex="-1"
              @mousedown.prevent
              @click="stepQty(-1)"
            >
              <SvgIcon :icon="IconMinusMedium" />
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
              :max="MAX_QTY"
              step="1"
              :value="item.qty"
              aria-label="Quantity"
              @change="onQty"
            />
            <!-- the mobile line's punctuation, hidden on the grid where the columns
                 do that job (and where a fourth thing wouldn't fit the track). It
                 trails the number in the markup because that is where it reads —
                 the + beside it is the one that stands down below $bp-stack. -->
            <span class="t-muted item__unit">×</span>
            <button
              class="btn btn--icon btn--ghost item__qtybtn foreground-quiet"
              type="button"
              :disabled="item.qty >= MAX_QTY"
              :aria-label="`One more ${item.name || 'item'}`"
              tabindex="-1"
              @mousedown.prevent
              @click="stepQty(1)"
            >
              <SvgIcon :icon="IconPlusMedium" />
            </button>
          </template>
        </div>

        <div class="item__weight">
          <!-- THE CATALOG DISAGREES: a quiet mark beside the weight it is about, and
               behind it the three things to do. It was a line under the row (a sentence,
               then buttons, then a boxed field: three tries on 2026-11-27), and each one
               spent a line of every disagreeing row on a note most rows only need to be
               ABLE to reach. A list just imported has a dozen of these, so the row says
               only that there is something (the mark) and the popover says what: take
               the catalog's figure, keep yours, or tell the catalog it is wrong.
               Left of the number: the figure is right-aligned, so that end of the cell
               is empty, and the column of numbers doesn't move for it.
               The trigger's name leads with what the tooltip shows and adds the row. -->
          <ItemRowMenu
            v-if="showFix"
            class="item__catnote"
            :row-id="item.id"
            kind="catalog"
            :label="`Catalog: ${catalogShown}`"
            :trigger-label="`Catalog: ${catalogShown}, for ${item.name || 'this item'}`"
            menu-label="The catalog's weight"
            trigger-class="item__catnote-btn"
            tooltip
          >
            <template #trigger>
              <SvgIcon :icon="VerifiedGlyph" />
            </template>
            <!-- THREE OUTCOMES, EACH NAMED BY ITS FIGURE, likeliest first: take the
                 catalog's, keep yours, or tell the catalog it is wrong. The figure leads
                 and its source follows ("Use 55 g from the catalog", not "the catalog's
                 55 g"), and the second says what putting the mark away MEANS, which
                 "Dismiss" left to be guessed (Ryan, 2026-11-27: "is this the copy you'd
                 use?"). The glyphs say the same three things: swap, tick, pencil. -->
            <li role="none">
              <button type="button" role="menuitem" class="menu__item item__fixuse" @click="menu.close(); useCatalogWeight()">
                <SvgIcon :icon="IconArrowsRepeatCircle" aria-hidden="true" />
                Use {{ catalogShown }} from the catalog
              </button>
            </li>
            <li role="none">
              <button type="button" role="menuitem" class="menu__item item__fixdismiss" @click="menu.close(); dismissFix()">
                <SvgIcon :icon="IconCheckmark1Medium" aria-hidden="true" />
                Keep {{ formatWeight(item.unitWeightMg, rowUnit) }}
              </button>
            </li>
            <li role="none" class="menu__foot">
              <button type="button" role="menuitem" class="menu__item item__fixsuggest" @click="menu.close(); openFix()">
                <SvgIcon :icon="IconPencil2" aria-hidden="true" />
                Suggest a catalog fix…
              </button>
            </li>
          </ItemRowMenu>
          <input
            class="field field--num"
            :value="isParent ? groupWeight : weightDisplay"
            placeholder="—"
            aria-label="Weight"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            enterkeyhint="next"
            :readonly="isWater || isParent"
            :tabindex="isWater || isParent ? -1 : undefined"
            :title="isParent ? 'Total of this group' : undefined"
            @focus="onWeightFocus"
            @change="onWeight"
            @keydown="onWeightKeydown"
            @keydown.up.prevent="onWeightStep($event, 1)"
            @keydown.down.prevent="onWeightStep($event, -1)"
          />
          <!-- The unit is SELECTABLE, not just typed. Entry units already worked by
               typing "3.8 oz", but that only helps if you know to try it — the label
               looked like a caption, so the feature was invisible. Same transparent-
               native-select idiom the total's unit uses (TotalsBar): the visible text
               stays exactly as it was, and the real control sits over it keeping the
               native picker and full keyboard behaviour.
               A GROUP row carries the very same picker — identical trigger, identical
               chevron — even though its figure is a sum rather than something typed:
               the choice is which unit that total READS in, and a stuff sack's 0.59 lb
               is exactly the number you want to see in ounces. Water carries it too, on
               the same grounds: its weight is derived from the litres beside it, but
               which unit that derived figure reads in is still yours to pick. -->
          <OptionMenu
            class="item__unitwrap"
            :options="WEIGHT_UNIT_OPTIONS"
            :current="rowUnit"
            :label="`Weight unit for ${item.name || (isParent ? 'this group' : 'this item')}`"
            :title="`Unit for ${item.name || (isParent ? 'this group' : 'this item')}`"
            @pick="(u) => onRowUnit(u as Unit)"
          >
            <template #trigger="{ open }">
              <span class="t-muted item__unit">{{ rowUnit }}</span>
              <!-- The mark that says "this is a control". Without it the unit was text
                   that looked exactly like a caption, so the picker was only ever found
                   by accident. Same chevron the total's unit carries, at row scale —
                   one vocabulary for one gesture. 12/2 renders an exact 1px stroke
                   (12 ÷ 24 × 2), the small-size counterpart to the total's 16/2.25. -->
              <SvgIcon
                :icon="IconChevronDownMedium"
                class="chev item__unitchev"
                :class="{ 'is-open': open }"
                size="xs"
                aria-hidden="true"
              />
            </template>
          </OptionMenu>
        </div>

        <!-- CLASSIFICATION — ONE mark, wearing what the row counts as: a dashed ring for
             base (nothing set), the shirt for worn, the cookie (or fuel can, or droplet) for a consumable,
             lit for the two that take the row out of base weight. It opens the choice
             and, under it, the one detail that only exists for the class chosen —
             worn's count, consumable's calories — so the row itself gains no second
             control. It was two toggles, consumable then worn, which cost every row a
             second slot for a field that holds one value. Water's class is fixed, so
             its row draws the lit mark with nothing behind it, in the same column. -->
        <!-- THE TRAILING CLUSTER — the marks and the controls, as one thing. On the
             desktop grid this wrapper is `display: contents`, so both cells drop into
             their own columns exactly as they did loose; it exists for the mobile line,
             where the two have to wrap TOGETHER. Split, they made two ragged rows of
             icons: the class cell ends in a centred glyph 13px inside its box and the
             actions end in the grip, whose dots deliberately overshoot to the row’s
             edge, so the stacked lines’ foreground landed 19px apart and lined up in no
             column at all. One item can only wrap whole. -->
        <div class="item__trail">
          <!-- ...and the marks stand down on a BARE GROUP for the same reason the count
               does. A class describes ONE row's own line, and a container's is zero — it
               contributes nothing to Base/Worn/Consumable whatever the toggles say, and
               it does not govern its children either: they inherit the FOLDER's default,
               never their parent's (effectiveClassification). So a lit cookie on a group
               is a claim about food that no number under it answers to, sitting where the
               eye reads it as covering the total beside it. A group carrying a line of
               its own keeps the marks — there the class does decide which bucket that
               line lands in. -->
          <div v-if="classCellShown" class="item__classcell">
            <div v-if="!isWater" ref="classRootRef" class="menu item__cls">
              <!-- Tooltip wraps the BUTTON, not the cell: the popover below is anchored
                   to .item__cls, and putting the wrapper around both would re-anchor it
                   to a div that only spans the trigger. The accessible name stays on the
                   control (aria-label) — the tooltip only adds the visible description,
                   so `title` is dropped to avoid the native bubble doubling it. -->
              <Tooltip :text="classTitle" :disabled="isClassOpen" preferred-placement="top">
                <button
                  class="btn btn--icon btn--ghost menu__btn item__clsbtn"
                  :class="{ 'item__mark': rowClass !== 'base' }"
                  type="button"
                  aria-haspopup="dialog"
                  :aria-expanded="isClassOpen"
                  :aria-label="classAria"
                  @mousedown.prevent
                  @click="toggleClass"
                >
                  <SvgIcon :icon="classGlyph" />
                </button>
              </Tooltip>
              <Transition name="menu">
                <div
                  v-if="isClassOpen"
                  ref="classPopRef"
                  class="popover item__pop"
                  :class="{ 'is-above': classAbove }"
                  :style="classShift ? { '--menu-shift': classShift + 'px' } : undefined"
                  role="dialog"
                  aria-label="Counts as"
                  @click="keepPopInView"
                  @change="keepPopInView"
                >
                  <!-- THE CHOICE. A row holds ONE class, so it is one control with
                       three settings — a radio group, which says "one of these" without
                       a line of text to explain it. The lit option is not a way off:
                       pressing it writes nothing (pickClass). -->
                  <div class="item__classes" role="radiogroup" aria-label="Counts as" @keydown="onClassKey">
                    <button
                      v-for="o in CLASS_OPTIONS"
                      :key="o.key"
                      ref="opts"
                      class="modebar__opt item__classopt"
                      :class="{ 'is-active': o.key === rowClass }"
                      type="button"
                      role="radio"
                      :aria-checked="o.key === rowClass"
                      :aria-label="o.name"
                      :tabindex="o.key === rowClass ? 0 : -1"
                      @click="pickClass(o.key)"
                    >
                      {{ o.label }}
                    </button>
                  </div>
                  <!-- How many: only on a row of several, because one of one is simply
                       "worn" (splitOffered), and never on a consumable.
                       The line over the control is the ANSWER, not a title: "2 worn ·
                       1 packed" (Ryan, 2026-11-25). It reads "0 worn · 3 packed" on a
                       base row, so the card is one height whichever of the two is lit
                       and the − that reaches none does not take the stepper away with it.
                       A STEPPER, the row's own quantity control on the card's ground:
                       − n +, with the figure typeable. It replaced count chips
                       (1 2 3 4 All) whose ceiling was the card's width — "does 4 feel
                       artificially limited", and it did. One control for every row
                       rather than chips for short rows and a stepper for long ones.
                       "All" stays beside it: the one count worth a press of its own. -->
                  <!-- What is under the choice changes with it, AT ONCE: no glide on the
                       lit option and no easing of the card's height. Both were built
                       (a travelling plate, then the sections folding, then one box
                       easing while the new content faded in) and taken out the same
                       day: "let's go no animation on this, bad idea" (Ryan,
                       2026-11-25). The options keep the tab chip's own colour fade. -->
                  <template v-if="splitOffered">
                    <p class="t-muted item__poplabel">{{ wornCount }} worn · {{ Math.max(0, item.qty - wornCount) }} packed</p>
                    <div class="item__splits">
                      <div class="item__wornstep">
                        <button
                          class="btn btn--icon btn--ghost item__wornbtn foreground-quiet"
                          type="button"
                          :disabled="wornCount <= 0"
                          aria-label="One fewer worn"
                          @click="setWornCount(wornCount - 1)"
                        >
                          <SvgIcon :icon="IconMinusMedium" />
                        </button>
                        <input
                          class="field field--num item__wornfield"
                          type="number"
                          min="0"
                          :max="item.qty"
                          step="1"
                          :value="wornCount"
                          aria-label="How many are worn"
                          @change="onWornCount"
                          @keydown.enter="($event.target as HTMLInputElement).blur()"
                        />
                        <button
                          class="btn btn--icon btn--ghost item__wornbtn foreground-quiet"
                          type="button"
                          :disabled="wornCount >= item.qty"
                          aria-label="One more worn"
                          @click="setWornCount(wornCount + 1)"
                        >
                          <SvgIcon :icon="IconPlusMedium" />
                        </button>
                      </div>
                      <!-- A SHORTCUT, not a state: it never lights. When all are worn,
                           Worn above is already lit and the figure and the line both
                           say so; a second lit chip beside it was two loud "on"s for
                           one fact. At the top it stands down with the + beside it,
                           the same way, for the same reason. -->
                      <button
                        class="btn btn--quiet item__split"
                        type="button"
                        :disabled="wornCount >= item.qty"
                        :title="`All ${item.qty} worn`"
                        @click="setWornCount(item.qty)"
                      >
                        All
                      </button>
                    </div>
                  </template>
                  <!-- calories only once the row IS consumable, and not on fuel that has
                       none to show — see kcalOffered -->
                  <template v-if="kcalOffered">
                    <!-- "each" only where there are several: on a row of one it asked
                         "each of what?" -->
                    <label class="t-muted item__poplabel" :for="`${item.id}-kcal`">{{ item.qty === 1 ? "kcal" : "kcal each" }}</label>
                    <input
                      :id="`${item.id}-kcal`"
                      class="field field--num well item__popinput"
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
                    <p v-if="item.kcal && item.qty > 1" class="t-muted item__popline">
                      <SvgIcon :icon="IconCalculator" class="item__poplineicon" aria-hidden="true" />
                      {{ formatKcal(item.kcal * item.qty) }} kcal for {{ item.qty }}
                    </p>
                  </template>
                  <template v-if="cookingOffered">
                    <div class="switch-row">
                      <span>Needs cooking</span>
                      <button class="switch" type="button" role="switch" :aria-checked="!!item.needsCooking"
                        aria-label="Needs cooking" @click="c.updateItem(item.id, { needsCooking: !item.needsCooking })" />
                    </div>
                    <!-- "for N boils" is the assumption, in the line: one boil an item.
                         It was a hover title only, which a phone never shows, and the
                         bare "~30 g fuel" read as a figure from nowhere. Same shape as
                         the calorie total above ("750 kcal for 3"), same derived mark. -->
                    <p v-if="item.needsCooking && !bareGroup" class="t-muted item__popline" role="status"
                      :title="`Assumes one boil per item, at ${ASSUMED_FUEL_PER_BOIL_G} g per boil.`">
                      <SvgIcon :icon="IconCalculator" class="item__poplineicon" aria-hidden="true" />
                      ~{{ item.qty * ASSUMED_FUEL_PER_BOIL_G }} g fuel for {{ item.qty }} {{ item.qty === 1 ? "boil" : "boils" }}
                    </p>
                  </template>
                </div>
              </Transition>
            </div>
            <!-- water's mark, not a control: its class can't change and it has no
                 calories to hold, so a choice and a kcal field here would both be
                 controls that lie. Same class, same "Consumable" name, the droplet
                 consumableIcon gives a water row — but NO lit plate: on this page the
                 plate is the look of a mark that opens a choice, and a lit droplet
                 among them was a button that did nothing when pressed (the share row's
                 argument for its own marks). The picture is the whole mark. -->
            <div v-else class="item__cls">
              <Tooltip text="Consumable" preferred-placement="top">
                <span class="item__clsfixed" role="img" aria-label="Consumable">
                  <SvgIcon :icon="consumableGlyph" />
                </span>
              </Tooltip>
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
                 at the open left edge, with the optional nesting control: the cluster
                 is right-aligned, so a conditional icon in
                 the middle would shuffle its neighbours from row to row, while out
                 here its absence moves nothing.
                 Not on water rows, the same rule the ⋯ menu applies: water is never
                 gear (isVaultWorthy), so the button's only possible outcome there was
                 a toast telling you to weigh a row that has a weight. -->
            <Transition name="vaultin" :css="vaultRevealArmed">
              <Tooltip v-if="vaultOffered" :text="vaultLabel" preferred-placement="top">
                <button
                  class="btn btn--icon btn--ghost item__vault-btn foreground-quiet"
                  :class="{ 'is-active': vaultSaved }"
                  type="button"
                  :disabled="vaultSave === 'saving'"
                  :aria-label="vaultLabel"
                  @mousedown.prevent
                  @click="onSaveToVault"
                >
                  <SvgIcon :icon="vaultSaved ? IconCheckmark1Medium : IconSafeSimple" />
                </button>
              </Tooltip>
            </Transition>
            <!-- NESTING, under one icon. These were up to two adjacent buttons whose
                 glyphs (list-plus, indent, outdent) are near-identical at 16px, so the
                 cluster read as noise and you had to hover each to learn which was which.
                 One trigger, and the menu SAYS what each action does.
                 Its glyph is node-add, not the indent arrow it wore first: the arrow drew
                 ONE of the entries behind it, and not the one that leads — a row's first
                 (often only) offer is a nested item, so an arrow promised the wrong thing
                 on most rows and lied outright on a nested one. Duplicate next door also
                 carries a plus; that one is enclosed in its square and this one stands
                 free above the branch, and both name themselves on hover.
                 Rendered only when there is something to offer — a nested row that can't
                 un-nest, or a parent with nothing to indent under, gets no icon at all
                 rather than a menu that opens empty.
                 item__nestact: stands down while a person filter is on (atoms/item.scss)
                 — "the item above" is unfiltered order, so indent could target a row the
                 CSS is hiding, and a nested row inherits its parent, so either action
                 can make the row vanish from the very view it was touched in.
                 The trigger's NAME carries the row, like the grip's; the tooltip and
                 the list keep the bare word. -->
            <ItemRowMenu
              v-if="nestActions.length"
              class="item__nest item__nestact"
              :row-id="item.id"
              kind="nest"
              label="Group"
              :trigger-label="`Group for ${item.name || 'item'}`"
              :icon="IconCodeTree"
              trigger-class="item__nest-btn"
              tooltip
            >
              <li v-for="a in nestActions" :key="a.label" role="none">
                <button type="button" role="menuitem" class="menu__item" @click="menu.close(); a.run()">
                  <SvgIcon :icon="a.icon" aria-hidden="true" />
                  {{ a.label }}
                </button>
              </li>
            </ItemRowMenu>
            <!-- CARRIED BY. Optional vault/nesting controls stay BEFORE this trigger,
                 so assignment, duplicate, remove and grip share fixed columns even
                 on a group with no nesting action. People exist list-wide, not per
                 row; an unassigned row keeps the same slot with its user glyph.
                 On a phone too: it had moved into the ⋯ menu there for want of
                 width, and came back when the two class toggles became one mark
                 (Ryan, 2026-11-25) — the line holds four boxes, as it did before. -->
            <ItemRowMenu
              v-if="peopleSorted.length"
              class="item__person"
              :row-id="item.id"
              kind="person"
              :label="personTitle"
              menu-label="Who carries this"
              trigger-class="item__person-btn"
              tooltip
            >
              <template #trigger>
                <span v-if="rowPerson" class="swatch" :style="{ background: personColor(rowPerson) }" aria-hidden="true" />
                <!-- nobody yet: the person with a pencil, "set who", rather than the
                     bare person, which read as a fact about the row and not as
                     something to press (Ryan, 2026-11-25) -->
                <SvgIcon v-else :icon="IconUserEdit" />
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
            <!-- DUPLICATE. The whole row copied one slot down — name, weight, class,
                 calories, carrier and any nested children. It earns an inline seat for
                 the same reason the vault save has one: it is a top-level action on the
                 row, not a refinement of one, and burying it would leave Alt-drag (which
                 a phone can't perform at all) as the only way to reach it. Mobile keeps
                 it in the ⋯ menu with the rest of the cluster. -->
            <Tooltip text="Duplicate" preferred-placement="top">
              <button
                class="btn btn--icon btn--ghost item__dup foreground-quiet"
                type="button"
                :aria-label="`Duplicate ${item.name || 'item'}`"
                @mousedown.prevent
                @click="c.duplicateItem(item.id)"
              >
                <SvgIcon :icon="IconSlideAdd" />
              </button>
            </Tooltip>
            <!-- "Remove", not "Remove item": the tooltip hangs off the row it acts on, so
                 the noun names something already on screen. The ACCESSIBLE name says
                 WHICH row ("Remove X-Mid 2" below, "Remove item" on an unnamed one) — a
                 screen reader reaches this button with no such context, and twenty
                 buttons named "Remove item" told it nothing — and WCAG 2.5.3 is
                 satisfied either way, since the accessible name opens with the visible
                 word. Same split as Duplicate beside it. -->
            <Tooltip text="Remove" preferred-placement="top">
              <button
                class="btn btn--icon btn--ghost item__del foreground-quiet"
                :aria-label="`Remove ${item.name || 'item'}`"
                @mousedown.prevent
                @click="c.removeItem(item.id)"
              >
                <SvgIcon :icon="IconTrashCan" />
              </button>
            </Tooltip>
            <!-- mobile overflow: on a phone the trailing icons crowd the two-line row, so
                 the nesting actions, the vault save, duplicate and remove collapse in
                 here (the class mark, the carrier and the grip stay on the row) — and desktop, which keeps the
                 inline icons, never shows it. Same .menu/.popover atom as the editor's ⋯
                 kebab; one row's menu open at a time (useItemMenu). -->
            <ItemRowMenu
              class="item__more"
              :row-id="item.id"
              kind="menu"
              label="More actions"
              :trigger-label="`More actions for ${item.name || 'item'}`"
              menu-label="Item actions"
              :icon="IconCircleDotsCenter1"
              trigger-class="menu__btn item__morebtn"
            >
              <!-- menu__foot on the LAST action, "Remove item", for the reason the
                   toolbar's menu rules off "Delete this list": everything above it
                   copies, moves or saves the item, and this one ends it. Foreground, not red:
                   it can be undone, and red is the list's own delete's alone. -->
              <li
                v-for="(a, i) in overflowActions"
                :key="a.label"
                role="none"
                :class="{ item__nestact: a.nest, menu__foot: i === overflowActions.length - 1 }"
              >
                <button type="button" role="menuitem" class="menu__item" @click="menu.close(); a.run()">
                  <SvgIcon :icon="a.icon" aria-hidden="true" />
                  {{ a.label }}
                </button>
              </li>
            </ItemRowMenu>
            <!-- drag via pointerdown; arrow keys give the focused grip the reordering
                 its label promises (a drag needs a pointer) -->
            <button
              class="btn btn--icon btn--ghost grip item__grip foreground-quiet"
              :title="`Drag to reorder · ${altLabel}-drag to duplicate`"
              :aria-label="`Reorder ${item.name || 'item'}`"
              @pointerdown="dnd.start(item.id, $event)"
              @keydown="onGripKey"
            >
              <SvgIcon :icon="IconDotGrid2x3" />
            </button>
          </div>
        </div>
      </div>
    </div>

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
}
/* position:relative makes the name BOX the autocomplete dropdown's anchor, so the
   menu opens flush with the row's left edge, directly under the name field (not under
   the sub-line that shares the cell), and its width math is box-based (see ItemInput
   .ac__menu) — the .ac root inside defers via position:static. */
.item__namebox {
  position: relative;
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
}
.item__namebox--group :deep(.ac) {
  flex: 0 1 auto;
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
.item__qty {
  grid-area: qty;
}
.item__weight {
  grid-area: weight;
}
/* the cell, not a classification wrapper, is what the grid places — the mark rides
   in the column the word "Consumable" used to occupy.
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
/* …and so is the trailing cluster inside it, for the same reason and by the same
   means — `display: contents` nests, so the class cell and the actions reach the
   grid's own `class` and `actions` areas through both wrappers. It is a real box
   only on the mobile line below, where its whole job is to be ONE flex item. */
.item__trail {
  display: contents;
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
/* ...and the row stops offering itself as a tap target when its box stands for no row
   (the disabled state above): the whole label is the control, so the pointer has to go
   with it or the row still reads as pressable. */
.item--check:has(.check__box:disabled) {
  cursor: default;
}
/* A press on the group's collapse chevron is a press on the LABEL too (:active climbs to
   ancestors, and a label's control takes it with it), so the checkbox atom's press rule
   dimmed the box for a tap that does not tick it. The chevron dims on its own; the box
   holds still. */
.item--check:has(button:active) .check {
  opacity: 1;
}
/* checkbox — the shared .check atom (controls.scss): Square (empty) under
   SquareCheck (checked), the same glyph as the header's packing toggle, stacked in
   one grid cell with the native control stretched invisibly over them, at the
   row's own glyph size and line. The row's only addition: the whole box is the tap
   target, so pointing at it darkens the glyph like the row's other quiet marks.
   Pointer-gated — it paints (see the note on .btn:hover, controls.scss): a tap on a
   phone would leave the glyph inked after the finger had gone. */
@media (hover: hover) and (pointer: fine) {
  .check:hover .check__icon {
    color: var(--foreground-primary);
  }
}
/* a group (parent) in packing mode: name + trailing collapse chevron, like the
   editor row + folder header */
.item__cname--group {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
}
/* the common name in packing mode — a quiet upright sub-line under the product name,
   spanning from the name column (2) to the row end so it aligns under the name, not the
   checkbox; the negative tuck pulls it snug beneath, like the read row's sub-line */
.item__csub {
  grid-column: 2 / -1;
  /* same caption tuck as the read/edit rows (shared token) so the common name sits the
     same distance under the name in packing mode too */
  margin-top: var(--caption-tuck);
  color: var(--foreground-secondary);
}
/* the variant on that sub-line: the aside voice the edit face's variant field and the
   read row's .item__rovariant use, a size under the upright gear type it qualifies */
.item__cvariant {
  color: var(--foreground-tertiary);
  font-style: italic;
}
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
/* A DERIVED weight — a group's total, water's litres-to-grams — is read, not typed
   (the input is readonly, and onWeight refuses it). It kept every affordance of a
   field all the same, so the parent of a nested group read as editable (Ryan,
   2026-09-05). Same box, so the column doesn't move; muted foreground, an arrow cursor and no
   caret, so the number reads as a figure. The unit chevron beside it stays live: the
   group's unit is still yours to pick.
   And ITALIC, number and unit both: the row's own vocabulary for "derived". A group's
   type line is already set in italic, and a total in the same voice reads as a sum of
   the items inside rather than a weight of its own (Ryan, 2026-09-05: chosen over a
   glyph before the figure, which would be one more mark to learn on the row #299 just
   quieted). The chevron is a glyph, so it stays upright. */
.item__weight .field:read-only {
  color: var(--foreground-secondary);
  cursor: default;
  caret-color: transparent;
  font-style: italic;
}
.item__weight:has(.field:read-only) .item__unit {
  font-style: italic;
}
/* the group's calorie readout, on the name line. It sat in the class column while that
   was two marks wide; one mark is narrower than "2,700 kcal". */
.item__gkcalinline {
  font-style: italic;
  white-space: nowrap;
  margin-left: var(--space-1);
  /* nowrap AND unshrinkable: with the reset's min-width: 0 a nowrap span can be
     squeezed below its own text and paint it over the chevron after it. The name
     beside it is what wraps. */
  flex: none;
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
/* the pop when the stepper moves the number — the shared `num-pop` keyframe
   (main.scss), the one the big total takes when it changes. blur(0) at rest, never
   `none`: the filter context has to persist between runs or WebKit drops it. */
.item__qtyfield {
  filter: blur(0);
  transform: translateZ(0);
}
.item__qtyfield.is-popping {
  animation: num-pop var(--spring-pop-dur) var(--spring-pop) both;
}
.item__unit {
  flex: none;
}
/* Quiet by default — one of these sits on every row, and a column of hard chevrons
   would shout louder than the weights they belong to. That resting step
   (--foreground-tertiary, and the pin that keeps it from shrinking) is the shared .chev
   now, atoms/controls.scss. Only the LIFT is the row's own: --foreground-secondary rather
   than the --foreground-primary every other chevron takes, because this one lifts on the
   ROW being hovered, not on its own trigger — a column of full-ink marks following the
   pointer down the list would read as the loud thing the quiet default exists to avoid. */
@media (hover: hover) and (pointer: fine) {
  .item:hover .item__unitchev {
    color: var(--foreground-secondary);
  }
}
/* the classification mark. --icon-btn wide, and the class track is derived from exactly
   that one box (tokens.scss). */
.item__cls {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
}
/* Water's fixed consumable mark: the control's exact box — .btn--icon's size — minus
   the button and minus the lit plate, because there is nothing to press. Sized like
   the button so the droplet sits in the column every other row's mark is in.
   --foreground-tertiary, the resting foreground of every glyph beside it
   (.foreground-quiet, controls.scss). It was --foreground-secondary, a step up to say "a
   fact, not a control" — but one step of grey between neighbours reads as a mismatch, not
   as a state, and the row already says water three other ways. The foreground only: no
   hover lift, since nothing here presses. */
.item__clsfixed {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn);
  min-height: var(--icon-btn);
  color: var(--foreground-tertiary);
}
/* ON is a FILLED GROUND, not just darker foreground — the shared `.item__mark` chip
   (atoms/item.scss), which the share views' rows draw as a static mark, so the two
   views can't drift on what "worn" looks like. Ink-vs-grey alone would be the same
   signal hover already uses, so a toggle would read as merely hovered.
   The OFF foreground is scoped to the off state (`:not`) rather than stated flat: a scoped
   rule carries its component's attribute, so a flat `.item__clsbtn` would outrank
   the shared chip's own colour and leave a lit toggle drawn in --foreground-tertiary. */
.item__clsbtn:not(.item__mark) {
  color: var(--foreground-tertiary);
}
.item__clsbtn {
  border-radius: var(--radius-pill);
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss) */
@media (hover: hover) and (pointer: fine) {
  .item__clsbtn:hover {
    color: var(--foreground-primary);
  }
}
@media (pointer: coarse) {
  /* the overshoot, as padding, so the chip's content box stays --icon-btn while the
     button stays --touch-target. box-sizing is border-box, so this costs the row no width.
     The fixed mark grows the same way — not for a tap target it doesn't have, but
     so a water row's cell measures what every other row's does. */
  .item__clsbtn,
  .item__clsfixed {
    padding: calc((var(--touch-target) - var(--icon-btn)) / 2);
  }
  /* The box the padding above was assuming, which nothing had actually declared.
     A BUTTON gets it from .btn--icon, whose own coarse rule takes width and
     min-height to --touch-target (controls.scss). The fixed mark is a <span> and gets
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
    width: var(--touch-target);
    min-height: var(--touch-target);
  }
}
/* anchored to the trigger, not the viewport: the point of the popover is that it
   opens where you were already looking. Right-aligned so it can't push the row's
   action cluster off a narrow screen. */
.item__pop {
  /* The popover's own padding, and the basis for its inner corners. --popover-item-radius
     (controls.scss) assumes --space-2 of padding; this surface uses more, so it re-derives
     the inner radius from its OWN padding rather than inheriting a value that would leave
     the field's corners rounder than the gap around them. */
  --pop-pad: var(--space-3);
  --pop-inner-radius: calc(var(--radius-4) - var(--pop-pad));
  /* The height of a control in the card. The worn stepper is as tall as the icon
     buttons at its ends, which a coarse pointer grows to --touch-target (controls.scss); the
     calorie field takes the same figure, so it is the stepper's height on every
     pointer rather than a text line's. */
  --pop-ctl-h: var(--icon-btn);
  @media (pointer: coarse) {
    --pop-ctl-h: var(--touch-target);
  }

  position: absolute;
  top: calc(100% + var(--space-1));
  /* under the middle of the ring, slid by --menu-shift (the name .menu__list--center
     reads) when that would leave the window (placeClass). `translate`, so it composes
     with the enter's transform; it grows from the middle of the edge that faces the ring. */
  left: 50%;
  translate: calc(-50% + var(--menu-shift, 0px)) 0;
  transform-origin: top center;
  z-index: var(--z-menu);
  display: grid;
  gap: var(--space-2);
  padding: var(--pop-pad);
  /* one width whatever is chosen, set by the three options on one line, so the card
     doesn't change size under the pointer as the choice moves */
  width: 15rem;
  /* air under the card when the page scrolls to keep a grown one in view (keepPopInView) — without it the card lands flush on the window's edge */
  scroll-margin-block: var(--space-2);
}
/* flipped when the row sits too close to the viewport floor (measured on open:
   placeClass) */
.item__pop.is-above {
  top: auto;
  bottom: calc(100% + var(--space-1));
  transform-origin: bottom center;
}
/* THE CHOICE: base · worn · consumable, as the app's own tabs — the mode bar's chip
   (.modebar__opt, atoms/modebar.scss), the way the share panel's two tabs wear it. No
   track and no outline: the chosen one takes --background-selected, the one tone for
   "this is the one that's on" (the row's own mark included, so the mark and the option
   that set it agree), and the others answer the pointer with the mode bar's wash. The
   chip brings its height, its foregrounds, the wash, the plate, the inward focus ring and
   the touch hit area; what's below is where an option here differs from one in the bar. A
   segmented track was built first and was the only one of its kind (Ryan, 2026-11-25: "can we
   use existing tab designs"). */
.item__classes {
  display: flex;
  gap: var(--space-half);
}
.item__classopt {
  /* the three share the card's width by their words, not equally ("Consumable" is
     twice "Base"), each growing by its share so the row ends on the card's padding
     edge; the word centres in what it is given */
  flex: 1 1 auto;
  justify-content: center;
  /* the card's concentric corner, like the well and the stepper under it, and the
     strong weight — both as the share panel's tabs take them */
  border-radius: var(--pop-inner-radius);
  font-weight: var(--font-weight-semibold);
}
/* Every line in the popover starts on the card's padding edge — the switch row, the
   labels, the field's box and the derived line all share it. An earlier version
   inset the labels to meet the field's TEXT, which was wrong twice over: the field's
   number is right-aligned so there is no left text edge to meet, and the field's BOX
   is the dominant vertical line, so indenting past it just read as two ragged edges. */
.item__poplabel {
  line-height: var(--leading-none);
  white-space: nowrap;
}
/* the worn count's row: the stepper takes what "All" leaves, so the row ends on the
   card's padding edge like the choice above it (Ryan, 2026-11-25, on the chips this
   replaced: "make all span wider to fix the internal padding") */
.item__splits {
  display: flex;
  gap: var(--space-1);
}
/* The stepper is the row's quantity control (.item__qty--step) on the card's ground:
   ONE box holding − n +, so the three read as a single control beside "All" rather than
   as three more chips. Its ground is the chip's and the kcal well's — an amount of foreground
   (see .item__split below). The figure carries no box of its own inside it, for the
   reason the row's doesn't: bare and centred, it is the stepper's value, not a third
   control between two. */
.item__wornstep {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  border-radius: var(--pop-inner-radius);
  background: var(--background-field);
}
.item__wornbtn {
  flex: none;
  border-radius: var(--pop-inner-radius);
}
.item__wornfield {
  flex: 1 1 0;
  min-width: 0;
  width: 0;
  text-align: center;
}
/* The chip's ground is AN AMOUNT OF FOREGROUND, the well's two (.well,
   atoms/controls.scss): 8% at rest, 10% under the pointer — the same pair the kcal field
   takes in the popover beside this one, so the two cards' grounds agree. It drew them in
   --background-secondary and --background-tertiary, page tones on a floating card: 1.10:1
   at rest on the light popover, and in dark --background-tertiary WAS --surface-1, so
   pointing at a count erased its chip. Not --background-selected: that is the tone for
   ON, and here on is the inverted chip below. */
.item__split {
  min-width: var(--icon-btn);
  min-height: var(--icon-btn);
  padding-inline: var(--space-2);
  border-radius: var(--pop-inner-radius);
  background: var(--background-field);
  color: var(--foreground-secondary);
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss) */
@media (hover: hover) and (pointer: fine) {
  .item__split:hover {
    background: var(--background-field-focus);
    color: var(--foreground-primary);
  }
}
/* .field is deliberately borderless — it lives in the row grid, where a box per cell
   would be pure noise. On a floating surface that reasoning inverts: with nothing
   around it the number reads as printed text, not as something you can type into.
   So the field declares itself here, and only here.
   A FILL rather than a border does it: --surface-1 is the brightest tone on the
   page, so a well sunk into it reads as "type here" at a glance, where a hairline
   rectangle has to be looked at to be seen.
   That fill is the .well atom (atoms/controls.scss), worn in the markup: an amount of
   foreground, which composites over the card, where the --background-secondary this used
   sat at 1.10:1 on it. Focus is the atom's too, the ground deepening a step and nothing
   drawn round it — the one focus every contained field on a floating surface takes (the
   trail panel's fields, the searches, the paste boxes). This one used to swap to
   --background-tertiary and add a hairline ring; the ring was standing in for a deepening
   that couldn't show, since --background-tertiary was the card's own colour in dark. Only
   the geometry is this field's — the transparent edge included: it is part of the box's
   size, and under forced colours, where fills are stripped, it is repainted and is all
   the field has. */
.item__popinput {
  /* the worn stepper's height, so the two cards' one control each measure the same:
     --pop-ctl-h is an icon button's box, which is what sets the stepper's (.item__pop) */
  min-height: var(--pop-ctl-h);
  padding: var(--space-1) var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--pop-inner-radius);
}
.item__popline {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
/* md, the scale's glyph for 16px text, which is what these lines are set in. It was
   sm, the step for 14px text, and read as a speck beside the figure (Ryan, 2026-11-25:
   "calc icon seems small here"). */
.item__poplineicon {
  flex: none;
  color: var(--foreground-tertiary);
}
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
/* …and the tooltips move with the glyphs. The rule above puts a 20px picture at the
   RIGHT edge of a 32px button, so a tooltip centred on the button lands 6px left of
   the thing it names — half the difference, on every control in this cluster.
   Derived from the two sizes, so it holds past 1920px where both grow (--px). Tooltip
   reads it back in JS, which works because main.scss REGISTERS --tip-shift as a
   <length>: unregistered, a calc() came back as its token stream and parsed to NaN,
   which is why this used to be a literal 8px.
   Declared on the CLUSTER, not the controls: custom properties inherit, so this one
   line reaches the triggers ItemRowMenu renders too — which a scoped rule can't. */
.item__actions {
  --tip-shift: var(--icon-inset);
}
/* banked: the tick holds at primary foreground so the row keeps saying so */
.item__vault-btn.is-active,
.item__vault-btn.is-active:hover {
  color: var(--foreground-primary);
}
.item__vault-btn:disabled {
  cursor: default;
}
/* The four TRAILING actions — save, nest, duplicate, remove — show for the row under
   the pointer or holding focus; the marks and the grip stay put (Ryan, 2026-09-05:
   seven icons on every row was the page's loudest thing). Fine pointers only: a thumb
   has no hover, so a phone keeps its ⋯ and a touch laptop keeps every icon in view.
   Opacity, not visibility: the buttons stay in the tab order and the accessibility
   tree — Tab into a row and its icons appear — and the cluster keeps its track, so the
   weights beside it never move. :focus-within also holds them while a row's own
   popover is open. */
@media (hover: hover) and (pointer: fine) {
  /* :not(.is-active) — a SAVED row's tick is state, not a control waiting to be used,
     and hiding it with the rest left nothing on a desktop row to say the item was in
     the vault until the mouse found it (the #302 review, 2026-09-05). */
  /* .item__nest, the inline nest TRIGGER, and not .item__nestact, which the ⋯ menu's
     nest entry wears too (for the person filter, atoms/item.scss). A narrow window on a
     fine pointer shows that menu, and its entry was hidden with the trigger: there
     while the pointer was over the row or the menu, a blank line in an open menu the
     moment it wasn't (Ryan, 2026-11-25: "move disappeared?"). */
  .item-row .item__vault-btn:not(.is-active),
  .item-row .item__nest,
  .item-row .item__dup,
  .item-row .item__del {
    opacity: 0;
    transition: opacity var(--spring-fade-dur) var(--spring-fade);
  }
  .item-row:hover .item__vault-btn,
  .item-row:hover .item__nest,
  .item-row:hover .item__dup,
  .item-row:hover .item__del,
  .item-row:focus-within .item__vault-btn,
  .item-row:focus-within .item__nest,
  .item-row:focus-within .item__dup,
  .item-row:focus-within .item__del {
    opacity: 1;
  }
}
/* THE QUANTITY STEPPER IS QUIET UNTIL WANTED. "− 1 +" stood on every row, three marks
   each, and on most lists nearly every count is 1: a column of controls saying nothing
   beside the one column (weight) the page is for.
   THE NUMBER ALWAYS SHOWS. A first version let a count of 1 rest unseen and Ryan turned
   it down on sight (2026-11-27: "I don't like quantity hidden"), which is the standing
   rule that a row's information isn't hidden until hover. So a 1 stays and steps back
   to the quiet ink, at every width, and any other count reads at full strength: "8"
   stakes is the figure the eye should find in the column.
   Only the − and + rest unseen, on the grid under a pointer that can hover, and come
   back when the row is under the pointer or holds focus, the way Duplicate and Remove
   do above. Written as the REST state (:not(:hover):not(:focus-within)) rather than as a
   reveal, so that under the pointer nothing here applies and a disabled − keeps
   .btn:disabled's own dimming; a reveal would have had to restate it.
   Opacity, never display: the track keeps its width, so the number stays centred in it. */
.item-wrap .item__qty--one .field {
  color: var(--foreground-tertiary);
}
/* being typed in, it is the field's own ink: a grey caret-holder reads as disabled */
.item-wrap .item__qty--one .field:focus {
  color: var(--foreground-primary);
}
@media (hover: hover) and (pointer: fine) and (min-width: #{$bp-stack + 1px}) {
  .item__qtybtn {
    transition: opacity var(--spring-fade-dur) var(--spring-fade);
  }
  .item-row:not(:hover):not(:focus-within) .item__qtybtn {
    opacity: 0;
  }
}
/* The save button's coming and going is STATE — the automatic capture releasing a
   row, or taking it. Arrival gets a little sizzle: the trigger pops in, and a
   light front sweeps left-to-right through the glyph — a soft-edged mask wipe
   over the icon held at primary foreground, whose final frame is the no-mask state, so the
   sweep ends where rest begins. When the enter class lifts, the button's own
   color transition (above) settles the lit glyph onto --foreground-tertiary — the SAME token
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
  animation: vault-pop calc(var(--spring-step-dur) * 3) var(--spring-step);
}
.vaultin-enter-active .item__vault-btn {
  color: var(--foreground-primary);
}
.vaultin-enter-active .item__vault-btn svg {
  mask-image: linear-gradient(100deg, #000 45%, rgba(0, 0, 0, 0) 65%);
  mask-size: 250% 100%;
  mask-repeat: no-repeat;
  animation: vault-shine calc(var(--spring-fade-dur) * 2.25) var(--spring-fade) calc(var(--spring-fade-dur) * 0.75) backwards;
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
    opacity var(--spring-fade-dur) var(--spring-fade),
    transform var(--spring-step-dur) var(--spring-step);
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
  z-index: var(--z-lifted);
  pointer-events: none;
  transform: translateY(var(--drag-dy, 0)) scale(1.01);
  /* a raised surface tone (not the page colour) so the lifted row reads as
     elevated in BOTH themes without a glow — dark gets a visible dark-grey card */
  background: var(--background-secondary);
  border-radius: var(--radius-2);
  /* a hairline ring (subtle in BOTH themes — no white glow in dark, which the
     old --ink-derived shadow caused) + the shared floating-surface drop (--shadow-pop,
     also used by the toast) so the two lifted surfaces read at one height */
  box-shadow:
    0 0 0 1px var(--border-strong),
    var(--shadow-pop);
  /* no `cursor` here. This row is pointer-events:none two lines up, so it is never
     hit-tested and never gets to set one — the `cursor: grabbing` that used to sit
     here had been dead since it was written (measured: the rule computed `grabbing`
     while the pointer showed `grab`, off a grip underneath). pointerDrag paints the
     drag cursor on <html>, the element that owns it while the pointer is captured. */
}
/* insertion line marking where the dragged row will land */
.item-wrap.is-drop-before::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--space-half);
  background: var(--foreground-primary);
  pointer-events: none;
}
/* "will nest under this row" — a left thread bar + faint tint on the target parent,
   the only cue when nesting under a row that has no children yet (and so no group
   tail line to light up). Mirrors the nested block's own left thread line. */
.item-wrap.is-nest-parent > .item {
  box-shadow: inset 2px 0 0 var(--foreground-primary);
  background: var(--background-secondary);
  border-radius: var(--radius-1);
}

/* the .reveal recipe now lives in atoms/controls.scss — three surfaces disclose the
   same way, and while it was scoped here the other two got the class names with none
   of the transition. Only this row's own VARIANT stays local. */
.reveal-enter-from,
.reveal-leave-to {
  --reveal-offset: 0;
}
/* the note tucks up under the name (into the 36px field's dead space); the offset
   lives on the wrapper, not the input, so the grid track sizing stays clean.
   Cancelling that dead space puts the caption's line box flush under the name's — the
   distance the read/share row matches with its 0 row-gap (ReadonlyItemRow .item--ro). */
.reveal--note {
  --reveal-offset: var(--caption-tuck);
}
/* The note can join a sub-line that is already standing for a saved gear type. It
   carries no tuck of its own — the parent has already spent that offset — but using the
   shared grid recipe means this one added line still pushes the row open and closed. */
.reveal--detail {
  --reveal-offset: 0;
}
/* the two sub-line fields (common name + note) stack as one grid child so the reveal's
   1fr↔0fr slide keeps a single clipping child; a hair of gap keeps the two lines apart */
.item__subfields {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* THE NOTE JOINS THE TYPE LINE WHEN IT FITS, as it always has on the share page
   ("Tent · 2P tent", ReadonlyItemRow's sub-line). It had a line to itself here whatever
   its length, so a row with a type and a two-word note stood three lines tall, and four
   with the catalog's note under it; thirty of those is most of the page's height.
   The stack becomes a wrapping row. The note sizes to its text (the engine's
   field-sizing, which the type and variant beside it already take), so a short one sits
   after the type and a long one fails to fit, drops to the next line and wraps there at
   the full width, which is exactly what it did before.
   THE DOT BETWEEN THEM has to be there on a shared line and gone when the note starts
   a line of its own, and nothing in CSS says which of those a wrapped flex item is. So
   the dot lives in a strip the note carries on its left and gives back with a negative
   margin: on a shared line the strip is the space between the two, and at the start of
   a line it hangs off the left edge of this box, which clips (.reveal > *, the slide's
   own overflow). The type line pays the strip's width back on its right so the two
   never overlap.
   Only where a field can size to its content. Elsewhere the column above stands. */
@supports (field-sizing: content) {
  .item__subfields {
    --sub-sep: calc(2 * var(--space-1) + 0.35em);
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
    column-gap: 0;
  }
  .item__subfields > .item__gtype-line {
    flex: 0 1 auto;
    max-width: 100%;
  }
  .item__subfields > .item__gtype-line:has(+ .reveal--detail) {
    margin-right: var(--sub-sep);
  }
  .item__subfields > .reveal--detail {
    position: relative;
    flex: 0 1 auto;
    max-width: calc(100% + var(--sub-sep));
    margin-left: calc(-1 * var(--sub-sep));
    padding-left: var(--sub-sep);
  }
  .item__subfields > .reveal--detail::before {
    content: "·";
    position: absolute;
    left: 0;
    top: 0;
    width: var(--sub-sep);
    text-align: center;
    color: var(--foreground-tertiary);
    font-size: var(--text-input);
  }
  .item__subfields > .reveal--detail > textarea.item__note {
    width: auto;
    min-width: 2ch;
    max-width: 100%;
  }
}
/* If one sub-line has a saved value, the shared reveal stays mounted when focus
   leaves. Let its empty sibling finish closing instead of disappearing mid-frame. */
.reveal-field-leave-active {
  transition: opacity var(--spring-step-dur) var(--spring-step);
}
.reveal-field-leave-to {
  opacity: 0;
}
/* the common-name field is an upright quiet LABEL (--foreground-secondary), distinct from
   the note's italic aside voice below it — mirrors the read-only sub-line's two voices.
   .item__note (atoms/item.scss) also matches this element and sets italic; the two
   classes together outweigh it. */
.item__note.item__gtype-input {
  color: var(--foreground-secondary);
  font-style: normal;
}
/* The gear type + variant line. The field keeps .item__note's width:100% as the
   FALLBACK, which puts the variant on the line below it; where the engine can size
   a field to its text (the same enhancement the list title takes, ListHead) the
   field hugs its word and the variant sits right after it. `wrap` is what makes the
   fallback a layout rather than an overflow. Baseline-aligned, so the label and the
   field's text share a line whatever the field's box does. */
.item__gtype-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: var(--space-1);
}
@supports (field-sizing: content) {
  .item__gtype-line .item__gtype-input,
  .item__gtype-line .item__variant-input {
    width: auto;
    field-sizing: content;
    min-width: 2ch;
    max-width: 100%;
  }
}
/* the variant field keeps .item__note's italic aside voice (the voice the row's name
   used for it before it moved down here), and the dot between the two fields takes the
   gear type's quiet upright foreground so it reads as punctuation, not as either field's
   text */
.item__gtype-dot {
  color: var(--foreground-tertiary);
}
/* THE CATALOG'S MARK in the weight cell. The glyph is the row's own size (--icon, as
   the class ring and the grip are): at a step smaller it read as a different kind of
   thing from the icons a few px away (Ryan, 2026-11-27: "seems small vs the other
   icons"). The BOX is the glyph and no more, not the row's 32px icon button, because it
   shares a 100px cell with a number: on the grid it also hangs a step out into the
   column gap on its left, which leaves the field room for a five-figure weight.
   :deep, because the button is ItemRowMenu's element and a scoped rule stops at that
   component's root (the first version of this rule never applied, and the button stood
   32px wide). No wash under the pointer: a 20px disc would hug the seal's own outline,
   and the foreground deepening (.foreground-quiet) already answers. The press area comes back to
   --touch-target on touch through an ::after, since growing the box would push the number. */
.item__catnote {
  flex: none;
  align-self: center;
  margin-left: calc(-1 * var(--space-2));
}
.item__catnote :deep(.item__catnote-btn) {
  position: relative;
  width: var(--icon);
  min-width: 0;
  height: var(--icon);
  min-height: 0;
  padding: 0;
  background: transparent;
}
@media (pointer: coarse) {
  .item__catnote :deep(.item__catnote-btn)::after {
    content: "";
    position: absolute;
    inset: calc((100% - var(--touch-target)) / 2);
  }
}
/* the collapse machinery (1fr↔0fr grid slide + clip) is the shared .nestcollapse atom
   (atoms/item.scss). The editor's only addition: lift the clip while a child's overlay
   is open or a drag is live, so a child's autocomplete dropdown / lifted row isn't
   cropped (mirrors the folder's :has(.popover) / is-dragpass lifts). The overlay half is
   keyed on the element for the reason the folder's is; an open group only, since a
   collapsed one's children can't open anything. */
.nestcollapse.is-lifted > .nest-block,
.nestcollapse:not([data-collapsed]) > .nest-block:has(.popover),
.nestcollapse:not([data-collapsed]) > .nest-block:has(button:focus-visible) {
  overflow: visible;
}

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
   between the glyph's footprint (--icon) and the swatch, taken off the right, puts its
   centre at 24 instead of 3px past it. */
/* (still reaches: the swatch is this component's slot content into ItemRowMenu, so
   it carries this scope id even though the button around it doesn't) */
.item__person-btn .swatch {
  /* 14px here, not the swatch's usual 10: on this trigger the dot stands where a 20px
     glyph does, between the class mark's ring (14px across) and the ⋯, and at 10 it
     was the smallest thing in the cluster (Ryan, 2026-11-25: "is carrier circle too
     small?"). The ring's own diameter, so empty ring and filled dot read as one size.
     Set as the atom's own variable, so the nudge below follows it. */
  --swatch: var(--icon-sm);
  margin-right: calc((var(--icon) - var(--swatch)) / 2);
}
/* picker entries: the chosen one wears the on-plate */
.item__personpick.is-active {
  background: var(--background-selected);
  color: var(--foreground-primary);
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
    padding-block: var(--space-half);
    line-height: var(--leading-snug);
  }
  /* …the ROW's text boxes, that is. The calorie field in the class card is a .field
     inside the row too, and the rule above was flattening it to a text line: 27px
     under a 32px stepper's worth of controls (Ryan, 2026-11-25: "should this be same
     height as worn stepper"). It keeps the card's own box here as on the wide layout. */
  .item-wrap .item .field.item__popinput {
    min-height: var(--pop-ctl-h);
    padding-block: var(--space-1);
    line-height: var(--leading-tight);
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
    /* CENTRED, not baseline — the same call .item__classcell makes on the grid and the
       read row's mobile stack makes on its own (--row-align: center, ReadonlyItemRow),
       for the same reason, arriving here last.
       `baseline` only works when every item on the line HAS a text baseline to share.
       Half of this line doesn't: the qty cell, the unit wrap and both icon clusters are
       flex boxes that centre their own contents, so none of them offers a baseline and
       each one gets a SYNTHESIZED one instead — a value the spec leaves the engine to
       derive, and here the engines disagreed. Measured from the rendered foreground
       against the pre-fix rules: WebKit put the count 2px off the weight beside it, and
       the grip 2px off the numbers, while Blink did not move a pixel — its own error was
       sub-pixel (the unit 0.4px high, the class toggles 0.8px above the ⋯ and the grip),
       which is to say Chrome reports this line as fine. Four cells, four reference edges,
       and no width at which they all agree.
       It takes a cell with NO TEXT ANYWHERE to break, which is why the icon clusters are
       the ones that did. A centred wrap that leads with a text span is not enough on its
       own — both engines take its baseline from that span, which is why the identically
       shaped .totals__uc, .headline__uc and .folder__actions were measured in WebKit and
       left alone.
       Centring needs no baseline from anyone, and it does not cost the numbers theirs:
       within one line box the baseline sits (ascent − descent) / 2 below the centre
       REGARDLESS of the box's height, so at one font size — which this whole line is —
       centring the boxes puts the text baselines on exactly the same y that baseline
       alignment was reaching for. The icons come along to that line's optical centre,
       which is where the row's other icon groups already aim. */
    align-items: center;
    /* Generous gap BETWEEN the groups (qty · weight · class) so they read as
       distinct — each number stays tight to its own ×/unit (see .item__qty gap +
       the 1ch field min-width); this is the separation between those pairs.
       It SHRINKS on the narrowest screens rather than holding at space-4 and
       overflowing. Once the classification cell became two toggles, a coarse
       pointer's --touch-target sizing left this line needing more width than a 375px phone
       has, and a fixed gap spends on air the controls need. Above ~640px it
       resolves to space-4 and nothing changes.
       The FLOOR is --space-3, not --space-2. At 8px the separation between the
       groups was only 4px more than the separation inside them (a number and its
       own unit), which is not a difference you can see — "1 × 540 g" read as one
       run of figures rather than a count and a weight. 12px against 4px is a ratio
       you can, and it is the one piece of this the grid gets for free from having
       columns at all. The 4px it costs a 375px line is affordable; below that the
       line wraps, which it already did.
       Named, because the trailing cluster below has to separate ITS two groups by
       exactly the same amount — it used to be one of this row's own gaps, and became
       a gap of its own the moment the two were wrapped into one flex item. */
    --meta-gap: clamp(var(--space-3), 2vw, var(--space-4));
    gap: var(--meta-gap);
    /* but the gap BETWEEN wrapped lines is the row's own rhythm, not the columns'
       separation — the same --space-1 the name and this line already sit apart by.
       After the shorthand, which would otherwise set both. */
    row-gap: var(--space-1);
    /* NO justify-content. There used to be a flex-end here, right-anchoring the line
       the auto margin couldn't reach — the actions cluster, wrapped down on its own,
       with no classification cell beside it to be pushed by. The cluster carries its
       own auto margin now (.item__trail below), and an auto margin absorbs the free
       space on WHATEVER line its item lands on, so both cases are one rule.
       Taking it out is what puts the numbers back on the left. flex-end reached the
       wrapped line's other item too: with the marks gone down to the cluster, the qty
       and weight were left alone up there and slid to the right edge, so a row that
       wrapped read its figures in a different place from every row that didn't. */
  }
  .item__actions {
    flex: none;
  }
  /* THE DESKTOP --field-h BOX, UNDONE — both halves of it, in one place, because it is
     one idea. On the grid these three cells sit `align-self: start` inside a box exactly
     --field-h tall: the grid AREA is as tall as the name cell and grows when its sub-line
     (gear type / note) opens, so the box is what keeps each cell on the name LINE instead
     of sinking to the middle of a three-line cell, and `start` is what pins the box to the
     top of that area.
     Down here there is no area to escape and no box to sit in — the flex line IS the box,
     and it is sized by the cells themselves. Both halves have to come off together: the
     height would hold a 36px box inside a ~25px line, and `start` would park three cells
     of three slightly different heights against the top of a line whose height they don't
     set, which is the wobble the centring above exists to remove.
     They were three separate `height: auto` declarations until the align-self reset joined
     them; keeping the two properties on one selector list is what stops a fourth cell being
     added to one list and forgotten in the other. */
  .item__qty--step,
  .item__classcell,
  .item__actions {
    height: auto;
    align-self: auto;
  }
  /* the --touch-target tap targets keep their size but overflow the (shorter) text line via
     negative margins, so the icons don't inflate the row and push the two text
     lines apart.
     BOTH icon groups on this line, not just the trailing one. The classification cell
     held a text label when this rule was written; once it became two --touch-target
     buttons it stood 44px tall inside a ~25px text line, and the flex line grew to fit it
     — which is the whole problem, and it is not one the line's own alignment can solve. A
     44px item makes a 44px line whatever you align it by (the line takes its cross size from
     its tallest item, and this rule ran when the line was still `baseline`, where the
     numbers then held the top of it while every icon centred ~10px below them).
     So the fix has to be the BOX, not the alignment: shrink each icon's footprint back
     to the text line's height and let the 44px target overflow it. That is what keeps
     the editing↔packing height parity .item--check is built around — the inflated line
     made an edit row 19px taller than the checklist row it toggles into, so the list
     jumped on every mode switch — and it is why these margins stay load-bearing now
     that the line centres (.item__meta above): centring aligns the icons, it does not
     stop a 44px one from setting the line's height. */
  .item__actions :deep(.btn--icon),
  .item__classcell .btn--icon,
  .item__classcell .item__clsfixed {
    min-height: 0;
    height: var(--touch-target);
    margin-block: var(--touch-target-pull);
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
  .item__classcell .item__clsfixed,
  .item__trail :deep(.item__person-btn),
  .item__trail :deep(.item__morebtn) {
    width: var(--touch-target);
    padding: calc((var(--touch-target) - var(--icon-btn)) / 2);
  }
  /* mobile trailing cluster = carrier (on a list that names people) · ⋯ · grip.
     Everything else the row can do — the note, the nesting actions, the vault save
     and the removal — moves into the ⋯ menu, which names each one in words rather
     than asking a glyph to. (The carrier was in there too while the class cell was
     two toggles wide; one mark gave its box back.)
     It is width that decides how many stay: on a coarse pointer every .btn--icon grows
     to --touch-target, so each inline icon costs 48px of a line that also has to carry
     the qty, the weight and the class mark. Delete was the last one held back —
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
  .item__actions .tooltip-trigger:has(.item__vault-btn),
  .item__actions .tooltip-trigger:has(.item__dup),
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
     on every row: "—" vs "12,250" swung these two toggles ~39px down a list while the
     right-anchored actions held still, so the tap targets you reach for most never
     formed a column. Pushing the cell right instead parks it against the actions —
     both clusters then ride the row's right edge, on every row, and the desktop grid's
     fixed class track (tokens.scss) gets its mobile equivalent. It costs no width: the
     free space it eats is the slack the widest row in the list doesn't have anyway.
     It must be the ONLY auto margin on the line — a second one splits the free space
     between them and the drift comes straight back at half size. The line that the
     cluster wraps onto is the SAME cluster (.item__trail is one flex item), so
     .item__meta's own justify-content right-anchors it there, not a second margin.
     The margin rides the cluster rather than the cell inside it, which is what makes
     the two travel together: a flex item can only wrap whole, so the marks now go
     down with the controls instead of staying up on the numbers' line as a second,
     shorter row of icons that lined up with nothing. */
  .item__trail {
    display: flex;
    align-items: center;
    /* ONE evenly spaced cluster on a phone, marks and controls alike (Ryan,
       2026-09-12: "align consumable and worn to the right and evenly space them").
       The gap between the two pairs is the same 4px as within them: it was the
       numbers' --meta-gap, which sets the pairs apart as groups on the wide grid line
       and read as a hole in the middle of the cluster here, on the numbers' line or
       wrapped under it. The separation from the weight stays the auto margin's.
       And that same gap is ZERO, inside the pairs too (the class cell's and the
       actions' own, below). Every box here is --touch-target wide, so a 4px gap between
       two of them is touch target spaced from touch target, which the eye never sees — what
       it sees is 28px of air between glyphs instead of 32, still even. On a 320px
       phone those three gaps were 12px of a line that wraps the moment "2.5 L" or
       "10 ×" asks for one more figure. The boxes touch; none overlaps. */
    gap: 0;
    flex: none;
    margin-left: auto;
  }
  .item__trail .item__classcell,
  .item__trail .item__actions {
    gap: 0;
  }
  /* …and the four GLYPHS at one pitch. The marks centre theirs; the ⋯ right-aligned
     its (the desktop rule, where the trailing glyphs line up on the grip), so it
     centres here too. The grip keeps its flush treatment (.grip: the glyph right-
     aligned in the box and shifted a third of itself out to the edge), which puts
     its dots, a narrow glyph, hard against the box's right edge; a centred glyph's
     centre is half a box in. Even to the EYE is even gaps between foreground, not between
     centres: the dots are a third the width of the round glyphs, so equal centres
     left a wider hole before the grip (Ryan, 2026-09-12: "still don't look evenly
     spaced"). So the dots come back by half a box and a little more, which
     puts their left edge the same 32px past the ⋯'s foreground as each glyph sits past
     the last. The 1px is
     Central's geometry at 18px: the ⋯'s foreground is 13.5px wide and the dots' 6px, which
     puts the dots' foreground 30px past the ⋯'s, as the marks sit apart. Replaces .grip's
     --grip-pull here: that pull evens the desktop cluster, where the ⋯ is
     right-aligned; this is the same idea for a centred one. The folder header below
     $bp-stack wears the same rule (atoms/folder.scss), so its trash stays in the ⋯'s
     column. */
  .item__trail :deep(.item__person-btn),
  .item__trail :deep(.item__morebtn) {
    justify-content: center;
  }
  /* the carrier's dot centres with them: its nudge onto the desktop cluster's
     right-aligned glyph column (.item__person-btn .swatch) has no column to meet here */
  .item__trail .item__person-btn .swatch {
    margin-right: 0;
  }
  /* THE GRIP'S BOX STARTS WHERE THE ⋯'S ENDS. To put the dots there it used to be a
     whole --touch-target box brought back by a negative margin of half a box and a pixel,
     which laid it over the right half of the ⋯, and on top of it, being later in the row:
     a tap on the ⋯'s centre or anywhere right of it landed on the grip, which does
     nothing on a tap, and only the left half of the glyph opened the menu (Ryan,
     2026-11-25: "sometimes this icon is a little hard to press on mobile"). Now the
     box is only what was left showing, so the dots have not moved, and what it gave
     up on the left it takes back on the right, out of the page gutter, where nothing
     else is: padding and a cancelling margin, so the line is laid out as before.
     --grip-bleed because that is as far as a row can reach: its wrapper is paint-
     contained and stops there (.item-wrap, atoms/item.scss), and a box that claimed
     more would be claiming taps it never gets. The box IS the target, so the focus
     ring drawn round it shows how far a press reaches; the ring itself lands past the
     containment, which stands down for a row with a focused button (item.scss).
     margin-left: 0 is against .grip's own pull. */
  .item__trail .item__grip {
    width: calc(var(--touch-target) / 2 - var(--px) + var(--grip-bleed));
    margin-left: 0;
    margin-right: calc(-1 * var(--grip-bleed));
    padding-right: var(--grip-bleed);
  }
  .item__classcell {
    flex: none;
    /* …and its LEADING tap overshoot comes out of the line, the way --touch-target-pull takes
       the vertical one. The marks' boxes are --touch-target wide down here (above), but what
       you see of a mark is its --icon-btn ground; the 6px either side of that is
       target, not picture. Left in, it stacked on --meta-gap: the weight's chevron sat
       18px from the first mark's ground where the gap promises 12, and on a 320px
       phone those 6px are what dropped "2 L 2,000 g" onto a line of its own. Pulled,
       the gap measures to the ground as it does between every other pair of groups.
       Only the leading edge: the box still sits whole on the right, where the marks'
       spacing to the ⋯ is the cluster's own. On a wrapped line the cell is
       right-anchored, so the 6px overhang lands in free space. */
    margin-left: calc((var(--icon-btn) - var(--touch-target)) / 2);
  }
  /* the number fields have no grid column to fill on mobile, so give them compact
     explicit widths — otherwise width:100% balloons to the default text-input size
     and each control wraps onto its own line */
  .item__qty,
  .item__weight {
    flex: none;
    /* and the cells centre their own parts too, for the reason the line above does.
       The weight cell is what forced it: its unit is wrapped in .item__unitwrap (a
       centred flex box, so that it can hold the picker's chevron beside the text), and
       asking a centred box for a baseline is asking for a synthesized one — which is how
       "lb" came to sit a fraction above the "0.03" it belongs to. Centring skips the
       question and lands the two on the same baseline exactly.
       .item__qty IS IN THIS SELECTOR FOR THE WATER ROW, and only for it — do not narrow
       this rule to .item__weight on the strength of the paragraph above. A water row's
       qty cell holds litres, so it keeps a plain field and carries no .item__qty--step
       (see the markup), and --step is where every other row gets its centring, from the
       unconditional rule further up. Drop .item__qty here and a water row alone falls
       back to the base `align-items: baseline` — its "L" against its own number, the
       same mismatch this rule exists to remove, on the one row type nobody thinks to
       check. */
    align-items: center;
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
  /* the catalog's mark trails the weight and its unit on this line: the figure starts
     at the cell's left edge down here, so the empty end is the other one */
  .item__weight .item__catnote {
    order: 3;
    margin-left: 0;
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
       falls back to min-width while still drawing its "—" placeholder, which then
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
    /* track 2 is the amount cell, sized by its own text — and a bare group's is EMPTY
       (see .item__cqty), which collapsed it to 0 and shunted that one row's weight a
       column-gap left of every other row's. A floor holds the column open for the rows
       that say nothing; `auto` above it still grows for a spelled-out split. */
    --row-cols: auto minmax(2.5ch, auto) 1fr;
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
    padding-block: var(--space-half);
    line-height: var(--leading-snug);
    display: flex;
    align-items: center;
  }
  .item__cqty {
    grid-column: 2;
    grid-row: 3;
  }
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
    grid-row: 2;
    margin-top: 0;
  }
}
</style>
