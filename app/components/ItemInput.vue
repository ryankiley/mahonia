<script setup lang="ts">
import { BadgeCheck } from "@lucide/vue";
import type { Unit } from "~~/shared/types";
import { formatWeight } from "~~/shared/weights";
import type { CatalogResult } from "~/composables/useCatalogSearch";

// Maps-grade autocomplete, used for BOTH adding a new item and renaming an
// existing one in place. In add mode it clears after commit; in edit mode
// (clearOnCommit=false) it keeps the value and only emits when it actually changed.
const props = withDefaults(
  defineProps<{
    unit: Unit;
    initial?: string;
    placeholder?: string;
    clearOnCommit?: boolean;
    withWeight?: boolean; // add mode: show a companion weight field in the weight column
  }>(),
  { initial: "", placeholder: "Add an item…", clearOnCommit: true, withWeight: false },
);
const emit = defineEmits<{
  commit: [
    { name: string; brand?: string; weight?: string; weightMg?: number; catalogItemId?: number },
  ];
}>();

const { results, search, clear } = useCatalogSearch();
const draft = ref(props.initial);
const weightDraft = ref(""); // add mode only — the companion weight field
const open = ref(false);
const active = ref(-1);
const focused = ref(false);
const rootRef = ref<HTMLElement | null>(null);

// keep an edit field in sync if the item name changes elsewhere (catalog pick,
// concurrent editor) — but never clobber what the user is actively typing
watch(
  () => props.initial,
  (v) => {
    if (!focused.value) draft.value = v;
  },
);

// guard so a programmatic commit/select (which changes `draft`) doesn't
// immediately re-open the menu via this watcher
let suppressOpen = false;
function setDraftQuiet(v: string) {
  suppressOpen = true;
  draft.value = v;
  nextTick(() => (suppressOpen = false));
}
watch(draft, (v) => {
  if (suppressOpen) return;
  search(v);
  active.value = -1;
  open.value = true;
});
onClickOutside(rootRef, () => (open.value = false));

// trailing weight in free text: "Tent 540 g" → name + weight; unitless ("UL2") stays in the name
const WEIGHT_TAIL = /\s+(\d[\d.,]*\s*(?:kgs?|g|grams?|oz|ounces?|lbs?|pounds?))$/i;

function close() {
  clear();
  open.value = false;
  active.value = -1;
}
function selectResult(r: CatalogResult) {
  // full display name (brand carried in the name, not a separate field, so exports
  // don't double it); the catalog link is preserved via catalogItemId.
  const name = [r.brand, r.name, r.variant].filter(Boolean).join(" ");
  emit("commit", { name, weightMg: r.weightMg, catalogItemId: r.id });
  // self-improving ranking: tell the catalog this item was used (fire-and-forget)
  $fetch("/api/catalog/use", { method: "POST", body: { ids: [r.id] } }).catch(() => {});
  setDraftQuiet(props.clearOnCommit ? "" : name);
  weightDraft.value = "";
  close();
}
function commitFree() {
  const raw = draft.value.trim();
  if (!raw) return;
  // editing an unchanged name (with no new weight typed) shouldn't emit a redundant update
  if (!props.clearOnCommit && raw === props.initial.trim() && !weightDraft.value.trim())
    return close();
  const m = raw.match(WEIGHT_TAIL);
  const name = (m ? raw.slice(0, m.index) : raw).trim();
  if (!name) return;
  // the companion weight field wins; else a trailing weight in the typed name
  const weight = weightDraft.value.trim() || (m ? m[1] : undefined);
  emit("commit", { name, weight });
  setDraftQuiet(props.clearOnCommit ? "" : name);
  weightDraft.value = "";
  close();
}
// commit when focus leaves the whole control (so tabbing name → weight doesn't commit early)
function onFocusOut(e: FocusEvent) {
  if (rootRef.value?.contains(e.relatedTarget as Node | null)) return;
  focused.value = false;
  commitFree();
}
function onKeydown(e: KeyboardEvent) {
  const n = results.value.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (n) {
      open.value = true;
      active.value = (active.value + 1) % n;
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (n) active.value = (active.value - 1 + n) % n;
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (open.value && active.value >= 0 && results.value[active.value])
      selectResult(results.value[active.value]!);
    else commitFree();
  } else if (e.key === "Escape") {
    // cancel: revert to the original (or clear in add mode) so the focusout that
    // follows blur won't commit the rejected draft
    setDraftQuiet(props.clearOnCommit ? "" : props.initial);
    open.value = false;
    active.value = -1;
    (e.target as HTMLInputElement).blur();
  }
}

// non-verified rows show a one-letter weight-source tag; verified rows get the
// BadgeCheck icon instead (see template)
const srcLetter = (r: CatalogResult) => (r.weightSource[0] || "?").toUpperCase();
</script>

<template>
  <div ref="rootRef" class="ac" :class="{ 'ac--add': withWeight }" @focusout="onFocusOut">
    <input
      v-model="draft"
      class="field ac__input"
      :placeholder="placeholder"
      :aria-label="placeholder"
      autocomplete="off"
      @keydown="onKeydown"
      @focus="focused = true; open = true"
    />
    <div v-if="withWeight && (focused || draft || weightDraft)" class="ac__weightcell">
      <input
        v-model="weightDraft"
        class="field field--num"
        placeholder="—"
        inputmode="decimal"
        aria-label="Weight"
        @keydown.enter="commitFree"
      />
      <span class="t-sm t-muted ac__unit">{{ unit }}</span>
    </div>
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
            class="t-muted"
          >
            · {{ r.variant }}</span
          >
        </span>
        <span class="ac__metaright">
          <span class="t-num ac__w">{{ formatWeight(r.weightMg, unit) }}</span>
          <span class="ac__src" :title="r.weightSource">
            <BadgeCheck v-if="r.verified" :size="14" :stroke-width="2" aria-hidden="true" />
            <template v-else>{{ srcLetter(r) }}</template>
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ac {
  position: relative;
}
/* add mode: same column template as item rows so the weight lands in the weight
   column (cols 4–5 reserved but empty, matching class + actions) */
.ac--add {
  display: grid;
  grid-template-columns: var(--item-cols);
  gap: var(--space-3);
  align-items: baseline;
}
.ac--add .ac__input {
  grid-column: 1;
}
.ac__weightcell {
  grid-column: 3;
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
}
@media (max-width: 560px) {
  .ac--add {
    grid-template-columns: var(--item-cols-mobile);
  }
}
.ac__unit {
  flex: none;
}
.ac__input {
  width: 100%;
  color: var(--ink);
}
.ac__menu {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + var(--space-1));
  z-index: 30;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-1);
  min-width: 16rem;
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
  font-weight: 600;
}
.ac__metaright {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  flex: none;
}
.ac__w {
  font-size: var(--text-sm);
  color: var(--ink-2);
}
.ac__src {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  color: var(--accent);
  width: 1.2em;
}
</style>
