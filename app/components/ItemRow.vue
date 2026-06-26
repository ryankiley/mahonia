<script setup lang="ts">
import type { Classification, Item, ListSnapshot } from "~~/shared/types";
import { effectiveClassification, formatWeight, lineMg, parseWeightInput } from "~~/shared/weights";

const props = withDefaults(
  defineProps<{ list: ListSnapshot; item: Item; packed?: boolean; readonly?: boolean }>(),
  { packed: false, readonly: false },
);
const c = useGearList();

const weightDisplay = computed(() =>
  props.item.unitWeightMg > 0
    ? formatWeight(props.item.unitWeightMg, props.list.displayUnit, { withUnit: false })
    : "",
);

const effClass = computed(() =>
  effectiveClassification(props.item, props.list.folders),
);

function onWeight(e: Event) {
  c.setItemWeight(props.item.id, (e.target as HTMLInputElement).value);
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

const CLASS_OPTS: { value: Classification | ""; label: string }[] = [
  { value: "", label: "Auto" },
  { value: "base", label: "Base" },
  { value: "worn", label: "Worn" },
  { value: "consumable", label: "Consum." },
];

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

  <template v-else>
    <div class="item" :class="{ 'item--packed': packed && item.packed }">
    <label v-if="packed" class="item__check">
      <input
        type="checkbox"
        :checked="item.packed"
        @change="c.updateItem(item.id, { packed: ($event.target as HTMLInputElement).checked })"
      />
    </label>

    <span v-if="packed" class="item__name item__name--ro">{{ item.name }}</span>
    <ItemInput
      v-else
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
      :disabled="packed"
      @change="c.updateItem(item.id, { qty: Math.max(1, Number(($event.target as HTMLInputElement).value) || 1) })"
    />

    <div class="item__weight">
      <input
        class="field field--num"
        :value="weightDisplay"
        placeholder="—"
        :disabled="packed"
        @change="onWeight"
      />
      <span class="t-sm t-muted item__unit">{{ list.displayUnit }}</span>
    </div>

    <select
      class="field item__class"
      :class="`item__class--${effClass}`"
      :value="item.classification ?? ''"
      :disabled="packed"
      :title="`Counts as ${effClass}`"
      @change="c.updateItem(item.id, { classification: (($event.target as HTMLSelectElement).value || null) as any })"
    >
      <option v-for="o in CLASS_OPTS" :key="o.label" :value="o.value">
        {{ o.value === "" ? `Auto · ${effClass}` : o.label }}
      </option>
    </select>

    <button
      v-if="!packed"
      class="btn btn--icon btn--ghost item__del"
      title="Remove item"
      aria-label="Remove item"
      @click="c.removeItem(item.id)"
    >
      ✕
    </button>
    </div>

    <button v-if="showFix" type="button" class="item__fix t-sm" @click="openFix">
      Catalog: {{ formatWeight(item.catalogWeightMgAtLink ?? 0, list.displayUnit) }} — suggest a fix
    </button>
  </template>
</template>

<style scoped>
.item {
  display: grid;
  grid-template-columns: 1fr 56px 84px 110px 32px;
  /* baseline so the name, qty, weight, unit + class text all sit on one line */
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-1) 0;
}
.item--packed {
  opacity: 0.45;
  text-decoration: line-through;
}
.item--ro {
  grid-template-columns: 1fr 44px 96px;
  align-items: baseline;
}
.item__roname {
  min-width: 0;
}
.item__roweight {
  text-align: right;
}
.item__check {
  display: flex;
  align-items: center;
  align-self: center;
}
.item__weight {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}
.item__unit {
  flex: none;
}
.item__name--ro {
  align-self: center;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item__class {
  font-size: var(--text-sm);
  color: var(--ink-2);
}
/* classification reads from its text label, not colour (chrome stays monochrome) */
.item__class--worn,
.item__class--consumable {
  color: var(--ink-2);
}
.item__del {
  color: var(--ink-3);
}
.item__del:hover {
  color: var(--ink);
}
.item__fix {
  align-self: start;
  margin: calc(-1 * var(--space-1)) 0 var(--space-2);
  padding: 0;
  background: none;
  border: 0;
  color: var(--ink-3);
  text-align: left;
  cursor: pointer;
}
.item__fix:hover {
  color: var(--accent);
}

@media (max-width: 560px) {
  .item {
    /* baseline is for the single-row desktop layout; the stacked mobile grid
       wants its cells centered in each track (baseline inflates the rows) */
    align-items: center;
    grid-template-columns: 44px 1fr 84px;
    grid-template-areas:
      "check name name"
      "check qty weight"
      "check class del";
    gap: var(--space-2);
  }
  .item:not(.item--packed) {
    grid-template-columns: 1fr 56px 84px;
    grid-template-areas:
      "name name name"
      "qty weight class"
      "del del del";
  }
  .item__check { grid-area: check; }
  .item__name { grid-area: name; }
  .item__qty { grid-area: qty; }
  .item__weight { grid-area: weight; }
  .item__class { grid-area: class; }
  .item__del { grid-area: del; justify-self: end; }
}
</style>
