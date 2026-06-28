<script setup lang="ts">
import { ChevronDown, CircleMinus, GripVertical, StickyNotePlus, StickyNoteX, X } from "@lucide/vue";
import type { Classification, Item, ListSnapshot, Unit } from "~~/shared/types";
import { effectiveClassification, formatWeight, fromMg, itemDisplayName, lineMg, parseWeightInput } from "~~/shared/weights";

const props = withDefaults(
  defineProps<{ list: ListSnapshot; item: Item; packed?: boolean; readonly?: boolean }>(),
  { packed: false, readonly: false },
);
const c = useGearList();

// drag-to-reorder (editable rows only)
const dnd = useItemDnd();
const isDragging = computed(() => dnd.dragId.value === props.item.id);
const isDropBefore = computed(
  () =>
    dnd.dragId.value != null &&
    dnd.dragId.value !== props.item.id &&
    dnd.drop.value?.beforeId === props.item.id,
);

// a just-added "Add an item" row autofocuses its name; if focus leaves the whole
// row while it's still untouched, it removes itself (no empty-row litter)
const wrapRef = ref<HTMLElement | null>(null);
const isPendingBlank = computed(() => c.pendingBlankId.value === props.item.id);
function onRowBlur(e: FocusEvent) {
  if (!isPendingBlank.value) return;
  const next = e.relatedTarget as Node | null;
  if (wrapRef.value?.contains(next)) return; // focus moved within the row — keep
  // focus left the window entirely (alt-tab / app switch) rather than moving
  // elsewhere in the app — keep the row so they can come back and finish it
  if (!next && typeof document !== "undefined" && !document.hasFocus()) return;
  const it = props.item;
  if (!it.name.trim() && it.unitWeightMg === 0 && it.qty === 1 && !it.description && it.catalogItemId == null) {
    c.discardBlank(it.id);
  }
}

// edit field: show the bare number in the list unit (formatWeight is strict, so
// the shown number stays in that unit — the unit label + parser agree, no rescale)
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
// exact "water" only — so "Water filter" stays a normal item, not a litres row
const isWater = computed(() => /^water$/i.test(props.item.name.trim()));
const litersDisplay = computed(() => {
  const l = props.item.unitWeightMg / 1_000_000;
  return l > 0 ? String(Number(l.toFixed(2))) : "";
});
// the qty shown in the static (read-only + checklist) views: water's "amount" is
// its volume in litres (matching the editable row's litres field), so it reads
// "2 L" rather than a meaningless "×1"; everything else keeps its ×quantity
const qtyLabel = computed(() =>
  isWater.value ? `${litersDisplay.value || "0"} L` : `×${props.item.qty}`,
);
function onWaterLiters(e: Event) {
  const el = e.target as HTMLInputElement;
  const liters = Math.max(0, Number(el.value) || 0);
  const ml = Math.round(liters * 1000);
  c.updateItem(props.item.id, {
    unitWeightMg: ml * 1000, // 1 mL water = 1000 mg
    weightOverridden: true,
  });
  el.value = litersDisplay.value; // resync (in-place op mutation makes it fresh)
}

function onWeight(e: Event) {
  if (isWater.value) return; // water weight is derived from its litres field
  const el = e.target as HTMLInputElement;
  c.setItemWeight(props.item.id, el.value);
  el.value = weightDisplay.value; // resync to canonical (handles unparseable / no-op edits)
}
function onQty(e: Event) {
  const el = e.target as HTMLInputElement;
  const q = Math.max(1, Number(el.value) || 1);
  c.updateItem(props.item.id, { qty: q });
  el.value = String(q); // resync even when the clamp is a no-op (e.g. 0 / letters)
}
// arrow keys nudge the weight by a unit-appropriate step (Shift = ×10), so you can
// tap into the field and increment/decrement without retyping
const STEP_BY_UNIT: Record<Unit, number> = { g: 1, kg: 0.01, oz: 0.1, lb: 0.1 };
function onWeightStep(e: KeyboardEvent, dir: 1 | -1) {
  if (isWater.value) return; // water weight is derived from its litres field
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
  weight?: string;
  weightMg?: number;
  catalogItemId?: number;
  classification?: Classification;
}) {
  const patch: Partial<Item> = { name: p.name };
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
  } else {
    // free text / water / trailing weight → a user-owned custom name: drop the
    // catalog-derived brand/variant and mark it so live-resolve won't overwrite it
    patch.brand = "";
    patch.variant = "";
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

const CLASS_OPTS: { value: Classification; label: string }[] = [
  { value: "base", label: "Base" },
  { value: "worn", label: "Worn" },
  { value: "consumable", label: "Consumable" },
];
function onClass(e: Event) {
  // folders always default to base, so there's no "Auto" — store base as null (default)
  const v = (e.target as HTMLSelectElement).value as Classification;
  c.updateItem(props.item.id, { classification: v === "base" ? null : v });
}
const effClassLabel = computed(() => CLASS_OPTS.find((o) => o.value === effClass.value)?.label ?? "Base");

// notes: toggled via an always-visible icon button (add/remove), not an
// always-present field; the note shows as live text once it has content
const noteOpen = ref(false);
const noteRef = ref<HTMLInputElement | null>(null);
// the note field is showing when there's a saved note OR it's been opened to type one
const noteShown = computed(() => !!props.item.description || noteOpen.value);
// plus → open the field; once shown (X) → hide it: clears a saved note, or just
// closes an accidentally-opened empty one (show/hide). editing a saved note is
// done by clicking its text.
function onNoteBtn() {
  if (noteShown.value) {
    if (props.item.description) c.updateItem(props.item.id, { description: "" });
    noteOpen.value = false;
  } else {
    noteOpen.value = true;
    nextTick(() => noteRef.value?.focus());
  }
}
// an opened-but-empty note collapses again when you click away without typing
function onNoteBlur(e: Event) {
  if (!(e.target as HTMLInputElement).value.trim()) noteOpen.value = false;
}

// "Fix for everyone": only offered once the user's weight diverges from the
// catalog value they linked — i.e. they think the canonical spec is wrong.
// A plain free-typed override (no catalog link) never nags.
const correction = useCatalogCorrection();
const showFix = computed(
  () =>
    !props.packed &&
    !props.readonly &&
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
  <!-- read-only row (shared with the public /s view) -->
  <div v-if="readonly" class="item item--ro">
    <span class="item__roname">
      <ItemName :item="item" /><span v-if="effClass !== 'base'" class="t-sm" :class="`item__class--${effClass}`"> · {{ effClass }}</span>
    </span>
    <span class="t-num t-sm t-muted item__roqty">{{ qtyLabel }}</span>
    <span class="t-num item__roweight"><template v-if="item.unitWeightMg > 0">{{ formatWeight(lineMg(item), list.displayUnit, { withUnit: false }) }} <span class="t-muted">{{ list.displayUnit }}</span></template><template v-else>—</template></span>
  </div>

  <!-- packing / checklist: a big tap target — check off the item; name + line weight only -->
  <label v-else-if="packed" class="item item--check" :class="{ 'item--done': item.packed }">
    <input
      type="checkbox"
      class="item__box"
      :checked="item.packed"
      @change="c.updateItem(item.id, { packed: ($event.target as HTMLInputElement).checked })"
    />
    <span class="item__cname"><ItemName :item="item" /></span>
    <span class="t-num t-sm t-muted item__cqty">{{ qtyLabel }}</span>
    <span class="t-num item__cweight"><template v-if="item.unitWeightMg > 0">{{ formatWeight(lineMg(item), list.displayUnit, { withUnit: false }) }} <span class="t-muted">{{ list.displayUnit }}</span></template><template v-else>—</template></span>
  </label>

  <!-- editable row (default) -->
  <div
    v-else
    ref="wrapRef"
    class="item-wrap"
    :data-item-id="item.id"
    :class="{ 'is-dragging': isDragging, 'is-drop-before': isDropBefore }"
    :style="isDragging ? { '--drag-dy': dnd.dy.value + 'px' } : undefined"
    @focusout="onRowBlur"
  >
    <div class="item">
      <ItemInput
        class="item__name"
        :unit="list.displayUnit"
        :initial="editableName"
        placeholder="Item name"
        :clear-on-commit="false"
        :autofocus="isPendingBlank"
        @commit="onNameCommit"
      />

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
            :value="weightDisplay"
            placeholder="--"
            inputmode="decimal"
            aria-label="Weight"
            :readonly="isWater"
            @change="onWeight"
            @keydown.up.prevent="onWeightStep($event, 1)"
            @keydown.down.prevent="onWeightStep($event, -1)"
          />
          <span class="t-sm t-muted item__unit">{{ list.displayUnit }}</span>
        </div>

        <div class="item__classwrap">
          <span class="item__classlabel">{{ effClassLabel }}</span>
          <ChevronDown class="item__classchev" :size="13" :stroke-width="2" aria-hidden="true" />
          <select
            class="item__classsel"
            :value="effClass"
            :title="`Counts as ${effClass}`"
            aria-label="Classification"
            @change="onClass"
          >
            <option v-for="o in CLASS_OPTS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>

        <div class="item__actions">
          <button
            class="btn btn--icon btn--ghost item__note-btn"
            :class="{ 'is-active': !!item.description }"
            :title="noteShown ? 'Remove note' : 'Add a note'"
            :aria-label="noteShown ? 'Remove note' : 'Add a note'"
            @click="onNoteBtn"
          >
            <StickyNoteX v-if="noteShown" :size="15" />
            <StickyNotePlus v-else :size="15" />
          </button>
          <button
            class="btn btn--icon btn--ghost item__del"
            title="Remove item"
            aria-label="Remove item"
            @click="c.removeItem(item.id)"
          >
            <CircleMinus :size="16" />
          </button>
          <button
            class="btn btn--icon btn--ghost item__grip"
            title="Drag to reorder"
            :aria-label="`Reorder ${item.name || 'item'}`"
            @pointerdown="dnd.start(item.id, $event)"
          >
            <GripVertical :size="15" />
          </button>
        </div>
      </div>
    </div>

    <!-- note: a single-line live-text field; appears once it has content or the note button is clicked -->
    <input
      v-if="item.description || noteOpen"
      ref="noteRef"
      class="item__note"
      :value="item.description ?? ''"
      placeholder="Add a note"
      aria-label="Item note"
      autocorrect="off"
      spellcheck="false"
      @change="c.updateItem(item.id, { description: ($event.target as HTMLInputElement).value })"
      @blur="onNoteBlur"
    />

    <div v-if="showFix" class="item__fixrow">
      <button type="button" class="item__under-link t-sm" @click="openFix">
        Catalog: {{ formatWeight(item.catalogWeightMgAtLink ?? 0, list.displayUnit) }} — suggest a fix
      </button>
      <button
        type="button"
        class="item__fixdismiss"
        title="Dismiss"
        aria-label="Dismiss suggestion"
        @click="dismissFix"
      >
        <X :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
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
.item__name {
  grid-area: name;
}
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

/* read-only (share view) */
.item--ro {
  grid-template-columns: var(--item-cols-ro);
  /* drop the base row's 5-area template ("name qty weight class actions") — this
     row only has 3 columns, and auto-placement fills them. Without this, the two
     phantom trailing area columns add two grid gaps after the weight, so it stops
     short of the row's right edge (the hairline runs full width). */
  grid-template-areas: none;
}
.item__roname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item__roweight {
  text-align: right;
}
/* the qty/amount label lives in the narrow 44px column; keep it on one line so a
   water row's volume ("1.75 L") never breaks between the number and its "L" unit.
   Shared by the read + checklist static views (the editable row uses a field). */
.item__roqty,
.item__cqty {
  white-space: nowrap;
}

/* packing / checklist — a big tap target */
.item--check {
  display: grid;
  grid-template-columns: auto var(--item-cols-ro);
  /* same as .item--ro: don't inherit the editable row's 5-area template, or its
     phantom trailing columns push the line weight in from the row's right edge */
  grid-template-areas: none;
  align-items: center;
  gap: var(--space-3);
  cursor: pointer;
  /* match the editable row height (a 36px field + the shared row padding) so
     toggling between packing and editing doesn't change row heights */
  min-height: calc(36px + 2 * var(--space-3));
}
/* custom monochrome checkbox — softly rounded square, fills with ink + a paper
   check. 4px sits between --radius-1 (2px, imperceptible here) and --radius-2 (8px,
   too round at 18px) — a slight, friendly rounding. */
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
  /* checkmark pops in with a springy overshoot on check (SPACE10's easeOutBack) */
  transform: scale(0);
  opacity: 0;
  transition:
    transform var(--dur) var(--ease-spring),
    opacity 120ms var(--ease);
}
.item__box:checked::after {
  transform: scale(1);
  opacity: 1;
}
.item__cname {
  min-width: 0;
}
.item__cweight {
  text-align: right;
}
.item--done {
  opacity: 0.5;
  text-decoration: line-through;
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
/* classification reads from its text label, not colour (chrome stays monochrome) */
.item__class--worn,
.item__class--consumable {
  color: var(--ink-2);
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
.item__del {
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.item__note-btn.is-active {
  color: var(--ink-2);
}
.item__grip:hover,
.item__note-btn:hover,
.item__del:hover {
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
  z-index: 50;
  pointer-events: none;
  transform: translateY(var(--drag-dy, 0)) scale(1.01);
  /* a raised surface tone (not the page colour) so the lifted row reads as
     elevated in BOTH themes without a glow — dark gets a visible dark-grey card */
  background: var(--paper-2);
  border-radius: var(--radius-2);
  /* a hairline ring (subtle in BOTH themes — no white glow in dark, which the
     old --ink-derived shadow caused) + a neutral black drop that reads as
     elevation in light; in dark the ring + the lift/motion carry it */
  box-shadow:
    0 0 0 1px var(--line-2),
    0 10px 24px -10px rgba(0, 0, 0, 0.35);
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
  .item__del,
  .item__note-btn:not(.is-active) {
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .item-wrap:hover :is(.item__del, .item__note-btn),
  .item-wrap:focus-within :is(.item__del, .item__note-btn) {
    opacity: 1;
  }
}

/* note — a single-line live-text field under the item (no box, no resize handle).
   reads as a caption: the lightest ink (matching the "Add an item" placeholder) and
   italic, to sit quietly beneath the item name. */
.item__note {
  width: 100%;
  min-height: 0;
  /* sit tight under the item line it captions. The editing name field is 36px tall
     with its text vertically centred, leaving dead space below the name; a negative
     top margin pulls the caption up into that gap so it reads as the name's second
     line. (mobile fields are compact — see the override in the media query.) */
  margin: calc(-1 * var(--space-1) - var(--space-px)) 0 0;
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
.item__fixdismiss {
  display: inline-flex;
  align-items: center;
  padding: 0;
  background: none;
  border: 0;
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.item__fixdismiss:hover {
  color: var(--ink);
}

@media (max-width: 560px) {
  /* the full-width name gets its own line so long product names never truncate;
     qty · weight · class + the controls reflow into a flex-wrap row beneath it,
     and the controls drop to a further line if that row runs out of width.
     Scoped to `.item-wrap .item` so the readonly + checklist rows keep their own
     layouts. */
  .item-wrap .item {
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
  .item__note {
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
  /* the 44px tap targets keep their size but overflow the (shorter) text line via
     negative margins, so the icons don't inflate the row and push the two text
     lines apart */
  .item__actions .btn--icon {
    min-height: 0;
    height: 2.75rem;
    margin-block: -0.65rem;
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
  .item__cqty,
  .item__cweight {
    padding-block: 2px;
    line-height: 1.3;
    display: inline-flex;
    align-items: center;
  }
  .item__cweight {
    grid-column: 3;
    grid-row: 2;
    justify-self: start;
    text-align: left;
  }

  /* read view adopts the checklist's two-line shape (mirrors .item--check above):
     the name takes its own line and wraps (never clips), and ×qty + weight sit
     together on a second line, flush-left — instead of the weight stranded out at
     the far-right margin on its own. */
  .item--ro {
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: var(--space-3);
    row-gap: var(--space-1);
  }
  .item__roname {
    grid-column: 1 / -1;
    grid-row: 1;
    white-space: normal;
    overflow: visible;
  }
  .item__roqty {
    grid-column: 1;
    grid-row: 2;
  }
  .item__roweight {
    grid-column: 2;
    grid-row: 2;
    justify-self: start;
    text-align: left;
  }
}
</style>
