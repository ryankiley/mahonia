<script setup lang="ts">
import type { Unit } from "~~/shared/types";
import { formatWeight } from "~~/shared/weights";
import type { CatalogResult } from "~/composables/useCatalogSearch";

const props = defineProps<{ unit: Unit }>();
const emit = defineEmits<{
  commit: [
    { name: string; brand?: string; weight?: string; weightMg?: number; catalogItemId?: number },
  ];
}>();

const { results, loading, search, clear } = useCatalogSearch();
const draft = ref("");
const open = ref(false);
const active = ref(-1);
const rootRef = ref<HTMLElement | null>(null);

watch(draft, (v) => {
  search(v);
  active.value = -1;
  open.value = true;
});
onClickOutside(rootRef, () => (open.value = false));

// trailing weight in free text: "Tent 540 g" → name + weight; unitless ("UL2") stays in the name
const WEIGHT_TAIL = /\s+(\d[\d.,]*\s*(?:kgs?|g|grams?|oz|ounces?|lbs?|pounds?))$/i;

function reset() {
  draft.value = "";
  clear();
  open.value = false;
  active.value = -1;
}
function selectResult(r: CatalogResult) {
  // full display name (brand carried in the name, not a separate field, so exports
  // don't double it); the catalog link is preserved via catalogItemId.
  const name = [r.brand, r.name, r.variant].filter(Boolean).join(" ");
  emit("commit", { name, weightMg: r.weightMg, catalogItemId: r.id });
  reset();
}
function commitFree() {
  const raw = draft.value.trim();
  if (!raw) return;
  const m = raw.match(WEIGHT_TAIL);
  const name = (m ? raw.slice(0, m.index) : raw).trim();
  if (!name) return;
  emit("commit", { name, weight: m ? m[1] : undefined });
  reset();
}
function onKeydown(e: KeyboardEvent) {
  const n = results.value.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (n) { open.value = true; active.value = (active.value + 1) % n; }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (n) active.value = (active.value - 1 + n) % n;
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (open.value && active.value >= 0 && results.value[active.value])
      selectResult(results.value[active.value]);
    else commitFree();
  } else if (e.key === "Escape") {
    open.value = false;
    active.value = -1;
  }
}

const badge = (r: CatalogResult) =>
  r.verified ? "✓" : (r.weightSource[0] || "?").toUpperCase();
</script>

<template>
  <div ref="rootRef" class="ac">
    <input
      v-model="draft"
      class="field ac__input"
      placeholder="Add an item…"
      aria-label="Add an item"
      autocomplete="off"
      @keydown="onKeydown"
      @blur="commitFree"
      @focus="open = true"
    />
    <ul v-if="open && results.length" class="ac__menu panel">
      <li
        v-for="(r, i) in results"
        :key="r.id"
        class="ac__opt"
        :class="{ 'is-active': i === active }"
        @mousedown.prevent="selectResult(r)"
        @mouseenter="active = i"
      >
        <span class="ac__name">
          <span v-if="r.brand" class="ac__brand">{{ r.brand }}</span> {{ r.name }}<span
            v-if="r.variant"
            class="t-faint"
          >
            · {{ r.variant }}</span
          >
        </span>
        <span class="ac__metaright">
          <span class="t-num ac__w">{{ formatWeight(r.weightMg, unit) }}</span>
          <span class="ac__src" :title="r.weightSource">{{ badge(r) }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ac {
  position: relative;
}
.ac__input {
  width: 100%;
  color: var(--ink-2);
}
.ac__menu {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 2px);
  z-index: 30;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-1);
}
.ac__opt {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2);
  cursor: pointer;
  font-size: var(--text-sm);
}
.ac__opt.is-active {
  background: var(--paper-3);
}
.ac__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ac__brand {
  font-weight: 700;
}
.ac__metaright {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  flex: none;
}
.ac__w {
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.ac__src {
  font-size: var(--text-xs);
  color: var(--accent);
  width: 1.2em;
  text-align: center;
}
</style>
