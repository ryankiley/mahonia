<script setup lang="ts">
import { BadgeCheck, Droplet } from "@lucide/vue";
import type { Classification, Unit } from "~~/shared/types";
import { formatWeight } from "~~/shared/weights";
import { formatVolume, parseVolumeMl, waterMgFromMl } from "~~/shared/water";
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
    {
      name: string;
      brand?: string;
      weight?: string;
      weightMg?: number;
      catalogItemId?: number;
      classification?: Classification;
    },
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

// Water folds into THIS input (no separate "add water"): typing a bare volume
// ("1 L", "500 ml", "32 fl oz") or "water [volume]" surfaces a water option that
// adds a consumable with the derived weight. "water" alone defaults to 1 L.
type WaterSug = { ml: number; label: string; weightMg: number };
const waterSuggestion = computed<WaterSug | null>(() => {
  const low = draft.value.trim().toLowerCase();
  if (!low) return null;
  let volStr: string | null = null;
  if (/^water\b/.test(low)) {
    const rest = low.replace(/^water\b/, "").trim();
    volStr = rest === "" ? "1l" : rest;
  } else if (/\bwater$/.test(low)) {
    volStr = low.replace(/\bwater$/, "").trim();
  } else if (parseVolumeMl(low) != null) {
    volStr = low;
  }
  if (volStr == null) return null;
  const ml = parseVolumeMl(volStr);
  if (ml == null || ml <= 0) return null;
  return { ml, label: `Water · ${formatVolume(ml)}`, weightMg: waterMgFromMl(ml) };
});

// the menu = an optional water row on top, then catalog results (one nav model)
type AcOption = { water: WaterSug } | { result: CatalogResult };
const options = computed<AcOption[]>(() => {
  const opts: AcOption[] = [];
  if (waterSuggestion.value) opts.push({ water: waterSuggestion.value });
  for (const r of results.value) opts.push({ result: r });
  return opts;
});

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
function selectWater(w: WaterSug) {
  emit("commit", { name: w.label, weightMg: w.weightMg, classification: "consumable" });
  setDraftQuiet(props.clearOnCommit ? "" : w.label);
  weightDraft.value = "";
  close();
}
function selectOption(opt: AcOption) {
  if ("water" in opt) selectWater(opt.water);
  else selectResult(opt.result);
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
  const n = options.value.length;
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
    if (open.value && active.value >= 0 && options.value[active.value])
      selectOption(options.value[active.value]!);
    else if (waterSuggestion.value) selectWater(waterSuggestion.value);
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
    <ul v-if="open && options.length" class="ac__menu panel">
      <li
        v-for="(opt, i) in options"
        :key="'water' in opt ? 'water' : opt.result.id"
        class="ac__opt"
        :class="{ 'is-active': i === active }"
        @mousedown.prevent="selectOption(opt)"
        @mouseenter="active = i"
      >
        <template v-if="'water' in opt">
          <span class="ac__name">
            <Droplet class="ac__watericon" :size="14" :stroke-width="2" aria-hidden="true" />{{ opt.water.label }}
          </span>
          <span class="ac__metaright">
            <span class="t-num ac__w">{{ formatWeight(opt.water.weightMg, unit) }}</span>
          </span>
        </template>
        <template v-else>
          <span class="ac__name">
            <span v-if="opt.result.brand" class="ac__brand">{{ opt.result.brand }}</span> {{ opt.result.name }}<span
              v-if="opt.result.variant"
              class="t-muted"
            >
              · {{ opt.result.variant }}</span
            >
          </span>
          <span class="ac__metaright">
            <span class="t-num ac__w">{{ formatWeight(opt.result.weightMg, unit) }}</span>
            <span class="ac__src" :title="opt.result.weightSource">
              <BadgeCheck v-if="opt.result.verified" :size="14" :stroke-width="2" aria-hidden="true" />
              <template v-else>{{ srcLetter(opt.result) }}</template>
            </span>
          </span>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ac {
  position: relative;
}
/* add mode: same column template as item rows so the input aligns with item names
   (col 2, past the grip gutter) and the weight lands in the weight column (col 4) */
.ac--add {
  display: grid;
  grid-template-columns: var(--item-cols);
  gap: var(--item-gap);
  align-items: baseline;
}
.ac--add .ac__input {
  grid-column: 2;
}
.ac__weightcell {
  grid-column: 4;
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
.ac__watericon {
  vertical-align: -2px;
  margin-right: var(--space-1);
  color: var(--ink-2);
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
