<script setup lang="ts">
import { ChevronDown, CircleMinus, GripVertical, StickyNoteMinus, StickyNotePlus } from "@lucide/vue";
import type { Classification, Item, ListSnapshot } from "~~/shared/types";
import { effectiveClassification, formatWeight, lineMg, parseWeightInput } from "~~/shared/weights";

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

// edit field: NEVER auto-promote (kg/lb) — the unit label + the parser both use
// the raw list unit, so the shown number must stay in that unit or a re-save
// silently rescales it (1000×/16×)
const weightDisplay = computed(() =>
  props.item.unitWeightMg > 0
    ? formatWeight(props.item.unitWeightMg, props.list.displayUnit, { withUnit: false, auto: false })
    : "",
);

const effClass = computed(() =>
  effectiveClassification(props.item, props.list.folders),
);

function onWeight(e: Event) {
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

// renaming in place via the same autocomplete: a catalog pick re-links + fills the
// weight; a free-text rename just updates the name (or its trailing weight).
function onNameCommit(p: {
  name: string;
  brand?: string;
  weight?: string;
  weightMg?: number;
  catalogItemId?: number;
}) {
  const patch: Partial<Item> = { name: p.name };
  if (p.catalogItemId != null) {
    patch.catalogItemId = p.catalogItemId;
    patch.unitWeightMg = p.weightMg;
    patch.catalogWeightMgAtLink = p.weightMg;
    patch.weightOverridden = false;
    if (p.brand) patch.brand = p.brand;
  } else if (p.weight != null) {
    const mg = parseWeightInput(p.weight, props.list.displayUnit);
    if (mg != null) {
      patch.unitWeightMg = mg;
      patch.weightOverridden = true;
    }
  }
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
// the note button adds (plus) when there's no note, removes (minus) when there is;
// editing an existing note is done by clicking its text
function onNoteBtn() {
  if (props.item.description) {
    c.updateItem(props.item.id, { description: "" });
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
</script>

<template>
  <!-- read-only row (shared with the public /s view) -->
  <div v-if="readonly" class="item item--ro">
    <span class="item__roname">
      {{ item.name
      }}<span v-if="effClass !== 'base'" class="t-sm" :class="`item__class--${effClass}`"> · {{ effClass }}</span>
    </span>
    <span class="t-num t-sm t-muted">×{{ item.qty }}</span>
    <span class="t-num item__roweight">{{
      item.unitWeightMg > 0 ? formatWeight(lineMg(item), list.displayUnit) : "—"
    }}</span>
  </div>

  <!-- packing / checklist: a big tap target — check off the item; name + line weight only -->
  <label v-else-if="packed" class="item item--check" :class="{ 'item--done': item.packed }">
    <input
      type="checkbox"
      class="item__box"
      :checked="item.packed"
      @change="c.updateItem(item.id, { packed: ($event.target as HTMLInputElement).checked })"
    />
    <span class="item__cname">{{ item.name }}</span>
    <span class="t-num t-sm t-muted">×{{ item.qty }}</span>
    <span class="t-num item__cweight">{{
      item.unitWeightMg > 0 ? formatWeight(lineMg(item), list.displayUnit) : "—"
    }}</span>
  </label>

  <!-- editable row (default) -->
  <div
    v-else
    class="item-wrap"
    :data-item-id="item.id"
    :class="{ 'is-dragging': isDragging, 'is-drop-before': isDropBefore }"
  >
    <div class="item">
      <ItemInput
        class="item__name"
        :unit="list.displayUnit"
        :initial="item.name"
        placeholder="Item name"
        :clear-on-commit="false"
        @commit="onNameCommit"
      />

      <input
        class="field field--num item__qty"
        type="number"
        min="1"
        :value="item.qty"
        @change="onQty"
      />

      <div class="item__weight">
        <input class="field field--num" :value="weightDisplay" placeholder="—" @change="onWeight" />
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
          class="btn btn--icon btn--ghost item__grip"
          title="Drag to reorder"
          :aria-label="`Reorder ${item.name || 'item'}`"
          @pointerdown="dnd.start(item.id, $event)"
        >
          <GripVertical :size="15" />
        </button>
        <button
          class="btn btn--icon btn--ghost item__note-btn"
          :class="{ 'is-active': !!item.description }"
          :title="item.description ? 'Remove note' : 'Add a note'"
          :aria-label="item.description ? 'Remove note' : 'Add a note'"
          @click="onNoteBtn"
        >
          <StickyNoteMinus v-if="item.description" :size="15" />
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
      @change="c.updateItem(item.id, { description: ($event.target as HTMLInputElement).value })"
      @blur="onNoteBlur"
    />

    <button v-if="showFix" type="button" class="item__under-link t-sm" @click="openFix">
      Catalog: {{ formatWeight(item.catalogWeightMgAtLink ?? 0, list.displayUnit) }} — suggest a fix
    </button>
  </div>
</template>

<style scoped>
.item {
  display: grid;
  grid-template-columns: var(--item-cols);
  /* baseline so the name, qty, weight, unit + class text all sit on one line */
  align-items: baseline;
  gap: var(--space-3);
  /* vertical padding comes from the row wrapper (.folder__items > *) so the rule
     lines between items sit at a consistent rhythm */
}

/* read-only (share view) */
.item--ro {
  grid-template-columns: var(--item-cols-ro);
}
.item__roname {
  min-width: 0;
}
.item__roweight {
  text-align: right;
}

/* packing / checklist — a big tap target */
.item--check {
  display: grid;
  grid-template-columns: auto var(--item-cols-ro);
  align-items: baseline;
  gap: var(--space-3);
  cursor: pointer;
}
/* custom monochrome checkbox — sharp square, fills with ink + a paper check */
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
  border-radius: var(--radius-0);
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
.item__box::after {
  content: "";
  width: 4px;
  height: 8px;
  margin-top: calc(-1 * var(--space-px));
  border: solid var(--paper);
  border-width: 0 2px 2px 0;
  /* checkmark pops in with a springy overshoot on check (SPACE10's easeOutBack) */
  transform: rotate(45deg) scale(0);
  opacity: 0;
  transition:
    transform var(--dur) var(--ease-spring),
    opacity 120ms var(--ease);
}
.item__box:checked::after {
  transform: rotate(45deg) scale(1);
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
.item__weight {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
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
.item-wrap.is-dragging {
  opacity: 0.4;
  pointer-events: none;
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
.item__grip {
  cursor: grab;
  touch-action: none;
}
.item__grip:active {
  cursor: grabbing;
}

/* note — a single-line live-text field under the item (no box, no resize handle) */
.item__note {
  width: 100%;
  min-height: 0;
  margin: var(--space-1) 0 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-2);
  font-size: var(--text-base);
}
.item__note::placeholder {
  color: var(--ink-3);
}
.item__note:focus {
  outline: none;
  color: var(--ink);
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

@media (max-width: 560px) {
  /* the EDITABLE item reads as ONE data row — name · qty · weight; the controls
     (classification + grip/note/remove) sit on a quiet second row. The actions
     cluster spans two tracks so all three icons fit. Scoped to `.item-wrap .item`
     so the readonly (.item--ro) and checklist (.item--check) rows keep their own
     grids instead of inheriting this two-row template. */
  .item-wrap .item {
    align-items: baseline;
    grid-template-columns: var(--item-cols-mobile);
    grid-template-areas:
      "name qty weight"
      "class actions actions";
    gap: var(--space-2) var(--space-3);
  }
  .item__name {
    grid-area: name;
    min-width: 0;
  }
  .item__qty {
    grid-area: qty;
  }
  .item__weight {
    grid-area: weight;
  }
  .item__classwrap {
    grid-area: class;
    justify-self: start;
  }
  .item__actions {
    grid-area: actions;
    justify-self: end;
  }
}
</style>
