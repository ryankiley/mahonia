<script lang="ts">
import type { Classification, Item as ItemT, Unit } from "~~/shared/types";

// static per-component tables — module scope so a large list doesn't rebuild
// them in every row instance
const STEP_BY_UNIT: Record<Unit, number> = { g: 1, kg: 0.01, oz: 0.1, lb: 0.1 };
// one stable empty array for every leaf row, so `children` never mints a fresh
// identity per row per render
const NO_ITEMS: ItemT[] = [];
const CLASS_OPTS: { value: Classification; label: string }[] = [
  { value: "base", label: "Base" },
  { value: "worn", label: "Worn" },
  { value: "consumable", label: "Consumable" },
];
// generated "N worn" split options stop here (the stored value is always shown
// even beyond the cap, so clamps/imports can't strand invisible state)
const MAX_SPLIT_OPTS = 5;
</script>

<script setup lang="ts">
import { ChevronDown, CircleEllipsis, GripVertical, IndentDecrease, IndentIncrease, ListPlus, StickyNotePlus, StickyNoteX, Trash2, X } from "@lucide/vue";
import type { Item, ListSnapshot } from "~~/shared/types";
import type { ItemPatch } from "~~/shared/ops";
import { bySortOrder, effectiveClassification, formatWeight, fromMg, groupLineMg, itemDisplayName, parseWeightInput, rowDisplayMg, siblingItems, splitWornQty } from "~~/shared/weights";
import { isWaterName, itemQtyLabel, waterLiters, waterMgFromMl } from "~~/shared/water";

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
    packed?: boolean;
    nested?: boolean;
  }>(),
  { prevId: null, packed: false, nested: false },
);
// forwarded up to FolderSection so it can lift its collapse clip while this row has a
// floating overlay open — the name autocomplete, or the mobile ⋯ menu (otherwise an
// overlay at the folder's bottom is cropped)
const emit = defineEmits<{ overlayToggle: [boolean] }>();
const c = useGearList();

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
onMounted(() => {
  try {
    nestCollapsed.value = localStorage.getItem(NEST_KEY) === "1";
  } catch {
    /* private mode / no storage — default expanded */
  }
});
function toggleNest() {
  nestCollapsed.value = !nestCollapsed.value;
  try {
    localStorage.setItem(NEST_KEY, nestCollapsed.value ? "1" : "0");
  } catch {
    /* ignore */
  }
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
  // blur must never discard a (still-unnamed) row
  if (props.packed) return;
  const next = e.relatedTarget as Node | null;
  if (wrapRef.value?.contains(next)) return; // focus moved within the row — keep
  // focus left the window entirely (alt-tab / app switch) rather than moving
  // elsewhere in the app — keep the row so they can come back and finish it
  if (!next && typeof document !== "undefined" && !document.hasFocus()) return;
  c.discardEmpty(props.item.id);
}

// edit field: the bare number in the list unit (formatWeight is strict, so the shown
// number stays in that unit — the unit label + parser agree, no rescale). A weight too
// small to show in the chosen unit renders as "<0.01" (never a wrong "0"); tapping in
// selects that label so a real number replaces it (onWeightFocus), and onWeight refuses
// to commit a "<…" label back as a value.
const weightDisplay = computed(() =>
  props.item.unitWeightMg > 0
    ? formatWeight(props.item.unitWeightMg, props.list.displayUnit, { withUnit: false })
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
function onQty(e: Event) {
  const el = e.target as HTMLInputElement;
  const q = Math.max(1, Number(el.value) || 1);
  c.updateItem(props.item.id, { qty: q });
  el.value = String(q); // resync even when the clamp is a no-op (e.g. 0 / letters)
}
// arrow keys nudge the weight by a unit-appropriate step (Shift = ×10), so you can
// tap into the field and increment/decrement without retyping
function onWeightStep(e: KeyboardEvent, dir: 1 | -1) {
  if (isWater.value || isParent.value) return; // water + group weights are derived, not typed
  const unit = props.list.displayUnit;
  const step = (STEP_BY_UNIT[unit] ?? 1) * (e.shiftKey ? 10 : 1);
  const current = fromMg(props.item.unitWeightMg, unit);
  const next = Math.max(0, Number((current + dir * step).toFixed(unit === "g" ? 0 : 2)));
  c.setItemWeight(props.item.id, String(next));
  // in-place op-reducer mutation makes weightDisplay fresh synchronously
  (e.target as HTMLInputElement).value = weightDisplay.value;
}

// renaming in place via the same autocomplete: a catalog pick re-links + fills the
// weight; a free-text rename just updates the name (or its trailing weight).
function onNameCommit(p: {
  name: string;
  brand?: string;
  variant?: string;
  commonName?: string;
  weight?: string;
  weightMg?: number;
  catalogItemId?: number;
  classification?: Classification;
}) {
  const patch: ItemPatch = { name: p.name };
  if (p.catalogItemId != null) {
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
    if (p.weightMg != null) {
      // a resolved weight with no catalog link (e.g. a water volume → fixed grams)
      patch.unitWeightMg = p.weightMg;
      patch.weightOverridden = true;
    } else if (p.weight != null) {
      const mg = parseWeightInput(p.weight, props.list.displayUnit);
      if (mg != null) {
        patch.unitWeightMg = mg;
        patch.weightOverridden = true;
      }
    }
  }
  // water arrives as a consumable; base is stored as null (the folder default)
  if (p.classification !== undefined) patch.classification = p.classification === "base" ? null : p.classification;
  c.updateItem(props.item.id, patch);
}

// a base row with multiples can split its count into worn + base (e.g. 3 pairs
// of socks, 1 worn) — the split lives in the same classification select as
// generated "N worn · M base" options, so the dense row gains no new control
const activeSplit = computed(() => splitWornQty(props.item, effClass.value)); // 0 = no split
const classOptions = computed<{ value: string; label: string }[]>(() => {
  const opts: { value: string; label: string }[] = [...CLASS_OPTS];
  if (isWater.value || effClass.value === "consumable") return opts;
  const counts = new Set<number>();
  for (let n = 1; n <= Math.min(props.item.qty - 1, MAX_SPLIT_OPTS); n++) counts.add(n);
  if (activeSplit.value > 0) counts.add(activeSplit.value);
  for (const n of [...counts].sort((a, b) => a - b))
    opts.push({ value: `worn:${n}`, label: `${n} worn · ${Math.max(0, props.item.qty - n)} base` });
  return opts;
});
const classValue = computed(() => (activeSplit.value > 0 ? `worn:${activeSplit.value}` : effClass.value));
function onClass(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  if (v.startsWith("worn:")) {
    // the remainder counts as base: keep the null (folder default) convention,
    // pinning explicit base only when the folder defaults elsewhere
    const folderDefault = effectiveClassification({ classification: null, folderId: props.item.folderId }, props.list.folders);
    c.updateItem(props.item.id, {
      wornQty: Number(v.slice(5)) || 0,
      classification: folderDefault === "base" ? null : "base",
    });
    return;
  }
  // folders always default to base, so there's no "Auto" — store base as null (default).
  // a plain pick also drops any split (wornQty 0 clears; worn/consumable clear in the reducer)
  c.updateItem(props.item.id, { classification: v === "base" ? null : (v as Classification), wornQty: 0 });
}
const effClassLabel = computed(() =>
  activeSplit.value > 0
    ? `${activeSplit.value} worn`
    : (CLASS_OPTS.find((o) => o.value === effClass.value)?.label ?? "Base"),
);
const classTitle = computed(() =>
  activeSplit.value > 0
    ? `Counts as ${activeSplit.value} worn, ${Math.max(0, props.item.qty - activeSplit.value)} base`
    : `Counts as ${effClass.value}`,
);

// the sub-line: the common name shows as an editable field whenever it's set (a catalog
// pick pre-fills it), the note is opt-in. The button reveals the empty fields so a common
// name / note can be added; each is cleared by emptying its own input.
const subOpen = ref(false);
const cnameRef = useTemplateRef<HTMLInputElement>("cnameRef");
const noteRef = useTemplateRef<HTMLInputElement>("noteRef");
// the sub-line block shows when a common name or note is set, OR the fields were opened to add one
const subShown = computed(
  () => !!props.item.commonName || !!props.item.description || subOpen.value,
);
// reveal the (empty) fields to add a common name / note; focus the common name. Toggling
// off just hides the empties — saved values keep showing and are edited/cleared in place.
function onSubBtn() {
  subOpen.value = !subOpen.value;
  if (subOpen.value) nextTick(() => cnameRef.value?.focus());
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
const isMenuOpen = computed(() => menu.openId.value === props.item.id);
watch(isMenuOpen, (open) => emit("overlayToggle", open));
function toggleMenu() {
  menu.toggle(props.item.id, menuRootRef.value);
}
// the same actions the inline icons run, in the order the icons sat: note, then the
// one nesting action that applies to this row's state (add-nested / nest-up / un-nest)
const overflowActions = computed(() => {
  const acts: { label: string; run: () => void }[] = [
    { label: subOpen.value ? "Hide common name & note" : "Common name & note", run: onSubBtn },
  ];
  if (props.nested) acts.push({ label: "Un-nest", run: () => c.unnest(props.item.id) });
  else {
    if (!isParent.value) acts.push({ label: "Add a nested item", run: () => c.addChild(props.item.id) });
    if (canIndent.value)
      acts.push({ label: "Nest under the item above", run: () => props.prevId && c.nestItem(props.item.id, props.prevId) });
  }
  return acts;
});
function runOverflow(a: { run: () => void }) {
  menu.close();
  a.run();
}

// "Fix for everyone": only offered once the user's weight diverges from the
// catalog value they linked — i.e. they think the canonical spec is wrong.
// A plain free-typed override (no catalog link) never nags.
const correction = useCatalogCorrection();
const showFix = computed(
  () =>
    !props.packed &&
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
    :style="isDragging ? { '--drag-dy': dnd.dy.value + 'px' } : undefined"
    @focusout="onRowBlur"
  >
    <!-- packing / checklist: a big tap target — check off the item; name + line weight only -->
    <label v-if="packed" class="item item--check" :class="{ 'item--done': item.packed }">
      <input
        type="checkbox"
        class="item__box"
        :checked="item.packed"
        :aria-label="`Packed: ${editableName || 'item'}`"
        @change="c.updateItem(item.id, { packed: ($event.target as HTMLInputElement).checked })"
      />
      <span class="item__cname" :class="{ 'item__cname--group': isParent }"><ItemName :item="item" /><button
          v-if="isParent"
          class="item__nestcollapse"
          :aria-expanded="!nestCollapsed"
          :aria-label="`${nestCollapsed ? 'Expand' : 'Collapse'} ${item.name || 'group'}`"
          :title="nestCollapsed ? 'Expand group' : 'Collapse group'"
          @mousedown.prevent
          @click.stop.prevent="toggleNest"
        ><ChevronDown class="item__nestchev" :class="{ 'is-collapsed': nestCollapsed }" :size="16" :stroke-width="2" /></button></span>
      <span class="t-num t-sm t-muted item__cqty">{{ itemQtyLabel(item, effClass) }}</span>
      <span class="t-num item__cweight"><template v-if="rowWeightMg > 0">{{ formatWeight(rowWeightMg, list.displayUnit, { withUnit: false }) }}<span class="t-muted item__wunit">{{ list.displayUnit }}</span></template><template v-else>—</template></span>
      <!-- the common name — a quiet sub-line under the product name (what you're checking
           off), aligned to the name column past the checkbox; mirrors the read row -->
      <span v-if="item.commonName" class="t-sm item__csub">{{ item.commonName }}</span>
    </label>

    <!-- editable row (default) -->
    <div v-if="!packed" class="item">
      <div class="item__name" :class="{ 'item__name--group': isParent }">
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
          <ChevronDown class="item__nestchev" :class="{ 'is-collapsed': nestCollapsed }" :size="16" :stroke-width="2" />
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
          <span class="t-sm t-muted item__unit">{{ list.displayUnit }}</span>
        </div>

        <div class="item__classwrap">
          <span class="item__classlabel">{{ effClassLabel }}</span>
          <ChevronDown class="item__classchev" :size="14" :stroke-width="2" aria-hidden="true" />
          <select
            class="item__classsel"
            :value="classValue"
            :title="classTitle"
            aria-label="Classification"
            @change="onClass"
          >
            <option v-for="o in classOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>

        <div class="item__actions">
          <!-- mousedown.prevent on the action buttons: on macOS Safari/Firefox a
               button does NOT take focus on mousedown, so clicking one from a
               focused input blurs the row (relatedTarget null) and a pristine
               blank row discards itself before the click can act (e.g. the note
               button would delete the row instead of opening the note field).
               Preventing the default keeps focus where it was; click still fires. -->
          <!-- add a nested item under this row (icon; a nested row can't nest further).
               Only on a row that has NO children yet — it's the entry point to START
               nesting. Once the group exists, its ever-present "Add an item" (below)
               is where more children get added, so the icon would be redundant. -->
          <button
            v-if="!nested && !isParent"
            class="btn btn--icon btn--ghost item__nest-btn"
            title="Add a nested item"
            aria-label="Add a nested item"
            @mousedown.prevent
            @click="c.addChild(item.id)"
          >
            <ListPlus :size="16" />
          </button>
          <!-- nesting: a child un-nests (outdent); a top-level row with a sibling above
               nests under it (indent). Reparenting is only these actions — never a drag. -->
          <button
            v-if="nested"
            class="btn btn--icon btn--ghost item__nest-btn"
            title="Un-nest (move out)"
            aria-label="Un-nest item"
            @mousedown.prevent
            @click="c.unnest(item.id)"
          >
            <IndentDecrease :size="16" />
          </button>
          <button
            v-else-if="canIndent"
            class="btn btn--icon btn--ghost item__nest-btn"
            title="Nest under the item above"
            aria-label="Nest under the item above"
            @mousedown.prevent
            @click="prevId && c.nestItem(item.id, prevId)"
          >
            <IndentIncrease :size="16" />
          </button>
          <button
            class="btn btn--icon btn--ghost item__del"
            title="Remove item"
            aria-label="Remove item"
            @mousedown.prevent
            @click="c.removeItem(item.id)"
          >
            <Trash2 :size="16" />
          </button>
          <button
            class="btn btn--icon btn--ghost item__note-btn"
            :class="{ 'is-active': !!(item.commonName || item.description) }"
            :title="subOpen ? 'Hide common name & note' : 'Common name & note'"
            :aria-label="subOpen ? 'Hide common name & note' : 'Add common name or note'"
            @mousedown.prevent
            @click="onSubBtn"
          >
            <StickyNoteX v-if="subOpen" :size="16" />
            <StickyNotePlus v-else :size="16" />
          </button>
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
              <CircleEllipsis :size="16" />
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
            <GripVertical :size="16" />
          </button>
        </div>
      </div>
    </div>

    <!-- sub-line: the common name (a quiet upright label) and, under it, the freeform note;
         both single-line live-text fields, appearing once either has content or the details
         button is clicked (editing only — the checklist row is name + weight, nothing else).
         The .reveal wrapper is a grid whose row animates 1fr↔0fr (Safari-safe slide); the two
         inputs share one inner child so that single-child slide stays clean. -->
    <Transition name="reveal">
      <div v-if="!packed && subShown" class="reveal reveal--note">
        <div class="item__subfields">
          <input
            v-if="item.commonName || subOpen"
            ref="cnameRef"
            class="item__note item__cname-input"
            :value="item.commonName ?? ''"
            placeholder="Common name — Tent, Shoes…"
            aria-label="Common name"
            autocorrect="off"
            spellcheck="true"
            @change="c.updateItem(item.id, { commonName: ($event.target as HTMLInputElement).value, commonNameOverridden: true })"
            @blur="onSubBlur"
          />
          <input
            v-if="item.description || subOpen"
            ref="noteRef"
            class="item__note"
            :value="item.description ?? ''"
            placeholder="Add a note"
            aria-label="Item note"
            autocorrect="off"
            spellcheck="true"
            @change="c.updateItem(item.id, { description: ($event.target as HTMLInputElement).value })"
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
            <X :size="14" />
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
          :packed="packed"
          nested
          @overlay-toggle="onChildOverlay"
        />
        <div v-if="isNestAppendTarget" class="item-nest__droptail" aria-hidden="true" />
        <button v-if="!packed" type="button" class="item-nest__add" @mousedown.prevent @click="c.addChild(item.id)">
          Add an item
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.item {
  display: grid;
  grid-template-columns: var(--item-cols);
  /* names sit flush at the page edge; the note + remove + grip live together in
     one trailing actions cluster (evenly spaced, same vertical centre) */
  grid-template-areas: "name qty weight class actions";
  /* baseline so the name, qty, weight, unit + class text all sit on one line */
  align-items: baseline;
  gap: var(--item-gap);
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
.item__classwrap {
  grid-area: class;
}
.item__actions {
  grid-area: actions;
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
  display: grid;
  grid-template-columns: auto var(--item-cols-ro);
  /* don't inherit the editable row's 5-area template — this row only has these
     columns, and the phantom trailing area columns would add two grid gaps after
     the weight, pushing it in from the row's right edge */
  grid-template-areas: none;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
  /* match the editable row height (a --field-h field + the shared row padding) so
     toggling between packing and editing doesn't change row heights */
  min-height: calc(var(--field-h) + 2 * var(--space-3));
}
/* custom monochrome checkbox — softly rounded square, fills with ink + a paper
   check. 4px is a deliberate off-scale radius: 2px is imperceptible here and
   --radius-2 (8px) too round at 18px — a slight, friendly rounding. */
.item__box {
  align-self: center;
  appearance: none;
  width: 18px;
  height: 18px;
  flex: none;
  display: grid;
  place-content: center;
  border: 1.5px solid var(--ink-3);
  background: var(--paper);
  border-radius: 4px;
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.item__box:hover {
  border-color: var(--ink);
}
.item__box:checked {
  background: var(--ink);
  border-color: var(--ink);
}
/* a drawn checkmark with ROUND caps/joins (from the design-system checkbox) — a
   paper-coloured shape masked by the tick SVG, so it adapts to light/dark. */
.item__box::after {
  content: "";
  width: 12px;
  height: 12px;
  background: var(--paper);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5 10 17.5 19 7'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5 10 17.5 19 7'/%3E%3C/svg%3E") center / contain no-repeat;
  /* checkmark pops in with a springy overshoot on check (SPACE10's easeOutBack);
     the fade runs the established faster-than---dur step (0.6×, cf. .menu-leave-active) */
  transform: scale(0);
  opacity: 0;
  transition:
    transform var(--dur) var(--ease-spring),
    opacity calc(var(--dur) * 0.6) var(--ease);
}
.item__box:checked::after {
  transform: scale(1);
  opacity: 1;
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
  margin-top: calc(-1 * var(--space-1));
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
.item__unit {
  flex: none;
}
.item__classwrap {
  position: relative;
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-px);
  min-width: 0;
}
.item__classlabel {
  font-size: var(--text-sm);
  color: var(--ink-2);
  white-space: nowrap;
}
/* transparent native select over the label + chevron: the visible label hugs the
   chevron tight (a styled <select> sizes to its widest option, leaving a big gap),
   while the real select keeps full keyboard + native-picker behaviour */
.item__classsel {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
}
.item__classchev {
  flex: none;
  align-self: center;
  color: var(--ink-3);
  pointer-events: none;
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
.item__del:hover,
.item__morebtn:hover {
  color: var(--ink);
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

/* desktop (mouse): keep rows clean — the note + remove controls are hidden at rest
   and fade in on row hover or keyboard focus. The reorder grip stays visible always
   (it's the affordance for the row). Opacity only (not display), so revealing never
   shifts the layout. Touch (hover: none) keeps everything visible. */
@media (hover: hover) {
  /* desktop: keep rows clean — remove + note + nest fade in on row hover/focus (the
     note stays lit when a note exists, but still HIDES at rest like the delete). The
     grip stays put. `> .item` scopes the reveal to a row's OWN cluster so hovering a
     parent doesn't reveal every nested child's icons. */
  .item__del,
  .item__note-btn:not(.is-active),
  .item__nest-btn {
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
    /* keep a standing compositing layer so Safari doesn't re-snap the icon ~1px when
       it creates a layer for the fade on the first hover (same WebKit quirk handled
       with will-change on .folder__chev) */
    will-change: opacity;
  }
  .item-wrap:hover > .item :is(.item__del, .item__note-btn, .item__nest-btn),
  .item-wrap:focus-within > .item :is(.item__del, .item__note-btn, .item__nest-btn) {
    opacity: 1;
  }
}

/* smooth disclosure for the note + fix-row — a grid whose one row animates 1fr↔0fr
   (cross-browser slide; Safari has no interpolate-size, so height:auto↔0 just snaps
   there). The inner child clips. reduced-motion → the global duration kill-switch
   makes it instant. */
.reveal {
  display: grid;
  grid-template-rows: 1fr;
}
.reveal > * {
  min-height: 0;
  overflow: hidden;
}
.reveal-enter-active,
.reveal-leave-active {
  transition:
    grid-template-rows var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}
/* the content also rises a touch as it fades — so the note reads as lifting into
   place, not just unveiling. Synced with the height reveal + the wrapper's fade. */
.reveal-enter-active > *,
.reveal-leave-active > * {
  transition: transform var(--dur) var(--ease);
}
.reveal-enter-from,
.reveal-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
.reveal-enter-from > *,
.reveal-leave-to > * {
  transform: translateY(0.4em);
}
/* the note tucks up under the name (into the 36px field's dead space); the offset
   lives on the wrapper, not the input, so the grid track sizing stays clean */
.reveal--note {
  margin-top: calc(-1 * var(--space-1) - var(--space-px));
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
.item__note.item__cname-input {
  color: var(--ink-2);
  font-style: normal;
}
.item__cname-input::placeholder {
  color: var(--ink-3);
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
/* ever-present "Add an item" at the bottom of a group — mirrors the folder's add row
   (quiet dim text, flush with the nested names), so growing a group needs no hover. It
   sits inside the thread line with the rest of the nested block; no horizontal rule. */
.item-nest__add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  min-height: var(--field-h);
  padding: var(--space-1) 0;
  background: none;
  border: 0;
  font-size: var(--text-base);
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.item-nest__add:hover {
  color: var(--ink);
}

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
  /* on the two-line mobile layout, indent the nested block so its content lands on
     the parent's WEIGHT column (one qty-column + gap in from the row edge) — the
     nested rows read as hanging under the weight above, not floating mid-name */
  .item-nest {
    margin-left: var(--space-5);
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
  /* the caption sits under the compact meta line here (not a tall 36px field), so
     the desktop negative pull would overlap — a small positive gap instead */
  .reveal--note {
    margin-top: var(--space-px);
  }
  /* one line only — qty · weight · class on the left, controls on the right — so a
     row is never more than two lines (name + this) and icons never land on a third */
  .item__meta {
    display: flex;
    flex-wrap: nowrap;
    align-items: baseline;
    /* generous gap BETWEEN the groups (qty · weight · class) so they read as
       distinct — each number stays tight to its own ×/unit (see .item__qty gap +
       the 1ch field min-width); this is the separation between those pairs */
    gap: var(--space-4);
  }
  .item__actions {
    margin-left: auto;
    flex: none;
    align-self: center;
  }
  /* the --tap tap targets keep their size but overflow the (shorter) text line via
     negative margins, so the icons don't inflate the row and push the two text
     lines apart */
  .item__actions .btn--icon {
    min-height: 0;
    height: var(--tap);
    margin-block: var(--tap-pull);
  }
  /* mobile trailing cluster = delete · ⋯ · grip. The note + nesting actions move
     into the ⋯ menu (item__more) so the two-line row isn't crowded; only delete
     stays inline beside the overflow. */
  .item__note-btn,
  .item__nest-btn {
    display: none;
  }
  .item__more {
    display: inline-flex;
  }
  /* keep delete visible at rest — the hover:hover reveal above assumes a mouse, but
     this breakpoint is also hit by touch devices that report hover:hover and by a
     narrowed desktop window, where a hover you can't perform shouldn't be the only
     way to reach it. `.item-wrap` prefix lifts specificity past the reveal's
     `:not(.is-active)`. */
  .item-wrap .item__del {
    opacity: 1;
  }
  /* the classification label is the only flexible piece — it ellipsizes on very
     narrow screens so qty/weight/controls keep their place on the single row */
  .item__classwrap {
    flex: 0 1 auto;
    min-width: 0;
  }
  .item__classlabel {
    overflow: hidden;
    text-overflow: ellipsis;
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
    }
  }

  /* checklist: the checkbox sits to the LEFT of the name (conventional checklist),
     in its own column spanning both text lines; the name is on its own line with
     ×qty · weight below. The two text lines keep the editing row's metrics (36px
     each) so toggling between editing and packing modes never reflows the row. */
  .item--check {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: center;
    column-gap: var(--space-3);
    row-gap: var(--space-1);
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
</style>
