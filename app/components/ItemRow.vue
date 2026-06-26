<script setup lang="ts">
import type { Classification, Item, ListSnapshot } from "~~/shared/types";
import { effectiveClassification, formatWeight } from "~~/shared/weights";

const props = defineProps<{ list: ListSnapshot; item: Item; packed: boolean }>();
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

const CLASS_OPTS: { value: Classification | ""; label: string }[] = [
  { value: "", label: "Auto" },
  { value: "base", label: "Base" },
  { value: "worn", label: "Worn" },
  { value: "consumable", label: "Consum." },
];
</script>

<template>
  <div class="item" :class="{ 'item--packed': packed && item.packed }">
    <label v-if="packed" class="item__check">
      <input
        type="checkbox"
        :checked="item.packed"
        @change="c.updateItem(item.id, { packed: ($event.target as HTMLInputElement).checked })"
      />
    </label>

    <input
      class="field item__name"
      :value="item.name"
      placeholder="Item name"
      :disabled="packed"
      @change="c.updateItem(item.id, { name: ($event.target as HTMLInputElement).value })"
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
      <span class="t-xs t-faint item__unit">{{ list.displayUnit }}</span>
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
</template>

<style scoped>
.item {
  display: grid;
  grid-template-columns: 1fr 56px 84px 110px 32px;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) 0;
}
.item--packed {
  opacity: 0.45;
  text-decoration: line-through;
}
.item__check {
  display: flex;
  align-items: center;
}
.item__weight {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}
.item__unit {
  flex: none;
}
.item__class {
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.item__class--worn {
  color: var(--cat-worn);
}
.item__class--consumable {
  color: var(--cat-consumable);
}
.item__del {
  color: var(--ink-3);
}
.item__del:hover {
  color: var(--cat-firstaid);
}

@media (max-width: 560px) {
  .item {
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
