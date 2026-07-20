<script setup lang="ts">
import { Droplet } from "@lucide/vue";
import type { EffectScope } from "vue";
import type { Classification, Unit } from "~~/shared/types";
import { formatWeight, itemDisplayName } from "~~/shared/weights";
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
    autofocus?: boolean; // focus the field on mount (a freshly-added blank row)
  }>(),
  { initial: "", placeholder: "Add an item…", clearOnCommit: true, autofocus: false },
);
const emit = defineEmits<{
  commit: [
    {
      name: string;
      brand?: string;
      variant?: string;
      commonName?: string;
      weight?: string;
      weightMg?: number;
      catalogItemId?: number;
      classification?: Classification;
    },
  ];
  // true while the suggestion dropdown is showing — the folder lifts its collapse
  // clip so a dropdown at the bottom of the folder isn't cropped (see FolderSection).
  // Named generically ("overlay") because the row's ⋯ menu rides the same lift.
  overlayToggle: [boolean];
  // Enter (the mobile return key too) landed a commit — the parent may continue
  // the flow by opening a fresh row below (todo-list entry; see ItemRow).
  advance: [];
}>();

const { results, search, clear } = useCatalogSearch();
const draft = ref(props.initial);
const open = ref(false);
const active = ref(-1);
const focused = ref(false);
const rootRef = useTemplateRef<HTMLElement>("rootRef");
const inputEl = useTemplateRef<HTMLInputElement>("inputEl");
// stable ids wiring the combobox to its listbox + active option, so assistive tech
// can announce the suggestions (the menu was a bare ul/li, invisible to AT)
const acId = useId();
const optId = (i: number) => `${acId}-opt-${i}`;
onMounted(() => {
  if (props.autofocus) inputEl.value?.focus();
});

// keep an edit field in sync if the item name changes elsewhere (catalog pick,
// concurrent editor) — but never clobber what the user is actively typing.
// QUIET sync: this is a programmatic update, not typing — a bare assignment
// would trip the draft watcher's search-and-open, popping the menu on rows
// nobody is touching whenever the server snapshot lands with a differing name
// (stale local cache on entry, a collaborator's rename via the poll).
watch(
  () => props.initial,
  (v) => {
    if (!focused.value) setDraftQuiet(v);
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
// Click-outside listeners exist only WHILE `open` — this component mounts once
// per row (collapsed folders keep rows mounted), so an unconditional call would
// pile two always-on window listeners per row, all running composedPath() on
// every tap, to close a menu only the single focused row can have open.
let outsideScope: EffectScope | null = null;
watch(open, (v) => {
  if (v && !outsideScope) {
    outsideScope = effectScope(true);
    outsideScope.run(() => {
      // The scope can attach MID-press (the press that focused the input and
      // opened the menu), and onClickOutside seeds "press started outside" as
      // true — so a text-selection drag from the input releasing outside would
      // read as an outside click and close the just-opened menu. Only a press
      // that STARTS after attach may close (the atom's own guard semantics).
      let sawPress = false;
      useWindowEvent("pointerdown", () => (sawPress = true), { passive: true });
      onClickOutside(rootRef, () => {
        if (sawPress) open.value = false;
      });
    });
  } else if (!v && outsideScope) {
    outsideScope.stop();
    outsideScope = null;
  }
});
onScopeDispose(() => outsideScope?.stop());

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

// the dropdown is position:absolute and can extend past the bottom of its folder,
// whose body clips overflow for the collapse animation. Signal the ancestor while the
// menu is showing so it can lift that clip (mirrors the drag-pass clip lift). Emit a
// closing toggle on unmount too, so a row removed mid-suggestion doesn't strand it.
const menuVisible = computed(() => open.value && options.value.length > 0);
// The folder lifts its collapse clip while we're lifted (a +1/−1 count), so only
// emit on genuine state CHANGES — dedup makes the count impossible to unbalance.
let acLifted = false;
function setLift(v: boolean) {
  if (acLifted === v) return;
  acLifted = v;
  emit("overlayToggle", v);
}
// Lift the clip the moment the menu shows, but release it only in the
// Transition's after-leave — releasing at leave START let the folder's
// overflow:hidden guillotine the exiting menu at t=0: everything below the
// folder's bottom edge vanished instantly while the slice inside kept fading,
// which read as "the top row hangs on". A leave cancelled by reopening never
// fires after-leave, and setLift's dedup means the re-show is a no-op — the
// clip just stays lifted through the whole blink.
watch(menuVisible, (v) => {
  if (v) setLift(true);
});
onBeforeUnmount(() => setLift(false));

// keyboard nav in a list taller than the scroller: keep the active option in
// view. Called ONLY from the arrow-key handlers — never from hover-set active:
// scrolling on hover would move the half-cropped fold row under a stationary
// pointer, and (Chrome/Firefox re-dispatch mouseenter when content scrolls under
// the cursor) let a resting mouse yank the highlight away from the keyboard row.
function scrollActiveIntoView() {
  nextTick(() => document.getElementById(optId(active.value))?.scrollIntoView({ block: "nearest" }));
}

function close() {
  clear();
  open.value = false;
  active.value = -1;
}
function selectResult(r: CatalogResult) {
  // store brand / model / variant as separate fields so the UI can render the
  // variant dimmed and linked items can live-resolve their name from the catalog.
  // The flat string is only used for the editable field + exports (itemDisplayName).
  emit("commit", {
    name: r.name,
    brand: r.brand ?? undefined,
    variant: r.variant ?? undefined,
    commonName: r.commonName ?? undefined,
    weightMg: r.weightMg,
    catalogItemId: r.id,
  });
  // self-improving ranking: tell the catalog this item was used (fire-and-forget)
  $fetch("/api/catalog/use", { method: "POST", body: { ids: [r.id] } }).catch(() => {});
  setDraftQuiet(props.clearOnCommit ? "" : itemDisplayName(r.brand, r.name, r.variant));
  close();
}
function selectWater(w: WaterSug) {
  // named just "Water" — the volume shows in the qty (litres) field, so "Water · 1 L"
  // in the name plus "1 L" in qty was redundant/confusing
  emit("commit", { name: "Water", weightMg: w.weightMg, classification: "consumable" });
  setDraftQuiet(props.clearOnCommit ? "" : "Water");
  close();
}
function selectOption(opt: AcOption) {
  if ("water" in opt) selectWater(opt.water);
  else selectResult(opt.result);
}
function commitFree() {
  const raw = draft.value.trim();
  if (!raw) return;
  // editing an unchanged name shouldn't emit a redundant update
  if (!props.clearOnCommit && raw === props.initial.trim()) return close();
  const m = raw.match(WEIGHT_TAIL);
  const name = (m ? raw.slice(0, m.index) : raw).trim();
  if (!name) return;
  // a trailing weight in the typed name ("Tent 540 g") rides along
  const weight = m ? m[1] : undefined;
  emit("commit", { name, weight });
  setDraftQuiet(props.clearOnCommit ? "" : name);
  close();
}
// commit when focus leaves the whole control
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
      scrollActiveIntoView();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (n) {
      active.value = (active.value - 1 + n) % n;
      scrollActiveIntoView();
    }
  } else if (e.key === "Enter") {
    if (e.isComposing) return; // IME confirming a composition, not a commit
    e.preventDefault();
    if (open.value && active.value >= 0 && options.value[active.value]) {
      selectOption(options.value[active.value]!);
    } else if (waterSuggestion.value) {
      selectWater(waterSuggestion.value);
    } else if (draft.value.trim()) {
      commitFree();
    } else {
      // Enter on an empty name ends the entry chain instead of spawning another
      // row: drop focus, so an untouched blank cleans itself up via the row's
      // focusout (discardEmpty) and the mobile keyboard dismisses
      (e.target as HTMLInputElement).blur();
      return;
    }
    emit("advance");
  } else if (e.key === "Escape") {
    // cancel: revert to the original (or clear in add mode) so the focusout that
    // follows blur won't commit the rejected draft
    setDraftQuiet(props.clearOnCommit ? "" : props.initial);
    open.value = false;
    active.value = -1;
    (e.target as HTMLInputElement).blur();
  }
}

// Split a suggestion into matched / unmatched runs against what's been typed, so
// the overlap reads bold — the standard typeahead affordance. Each whitespace
// token of the query is matched independently (so "hyperl wind" bolds both),
// case-insensitively. No exact overlap (a purely fuzzy hit) → one plain run.
function highlightParts(text: string): { t: string; on: boolean }[] {
  const q = draft.value.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter((t) => t.length > 1) : [];
  if (!tokens.length) return [{ t: text, on: false }];
  const lower = text.toLowerCase();
  const hit = new Array(text.length).fill(false);
  for (const tok of tokens) {
    let from = 0;
    for (let idx = lower.indexOf(tok, from); idx !== -1; idx = lower.indexOf(tok, from)) {
      for (let i = idx; i < idx + tok.length; i++) hit[i] = true;
      from = idx + tok.length;
    }
  }
  const parts: { t: string; on: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.on === hit[i]) last.t += text[i];
    else parts.push({ t: text[i]!, on: hit[i] });
  }
  return parts;
}
</script>

<template>
  <div ref="rootRef" class="ac" @focusout="onFocusOut">
    <input
      ref="inputEl"
      v-model="draft"
      class="field ac__input"
      :placeholder="placeholder"
      :aria-label="placeholder"
      :title="draft"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="open && options.length > 0"
      :aria-controls="`${acId}-listbox`"
      :aria-activedescendant="active >= 0 ? optId(active) : undefined"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      @keydown="onKeydown"
      @focus="focused = true; open = true"
    />
    <!-- pointer leaving the menu clears the hover highlight (mouseenter on options
         sets it; without this the last row stays lit). Keyboard arrows re-set it.
         The card (div) and the scroller (ul) are SEPARATE elements: a native
         scrollbar isn't clipped by border-radius, so scrolling happens on the
         inner list, safely inside the card's padding, never over the corners.
         <Transition name="menu"> = the kebab menu's pop-in (fade + spring rise),
         so the two floating menus arrive the same way. -->
    <Transition name="menu" @after-leave="setLift(false)">
    <div v-if="open && options.length" class="popover ac__menu" @mouseleave="active = -1">
    <ul :id="`${acId}-listbox`" class="ac__list" role="listbox">
      <li
        v-for="(opt, i) in options"
        :id="optId(i)"
        :key="'water' in opt ? 'water' : opt.result.id"
        class="ac__opt"
        role="option"
        :aria-selected="i === active"
        :class="{ 'is-active': i === active }"
        @mousedown.prevent="selectOption(opt)"
        @mouseenter="active = i"
      >
        <template v-if="'water' in opt">
          <span class="ac__name">
            <Droplet class="ac__watericon" :size="14" :stroke-width="2" aria-hidden="true" />{{ opt.water.label }}
          </span>
          <span class="ac__metaright">
            <span class="t-num ac__w">{{ formatWeight(opt.water.weightMg, unit, { withUnit: false }) }} <span class="t-muted">{{ unit }}</span></span>
          </span>
        </template>
        <template v-else>
          <!-- brand shrinks first (its matched prefix + an ellipsis survive), so the
               distinguishing model name + variant stay readable on a narrow phone menu -->
          <span class="ac__name">
            <span v-if="opt.result.brand" class="ac__brand">
              <span
                v-for="(p, pi) in highlightParts(opt.result.brand)"
                :key="pi"
                :class="{ 'ac__hl': p.on }"
              >{{ p.t }}</span>
            </span>
            <span class="ac__model">
              <span
                v-for="(p, pi) in highlightParts(opt.result.name)"
                :key="pi"
                :class="{ 'ac__hl': p.on }"
              >{{ p.t }}</span>
            </span>
            <span v-if="opt.result.variant" class="ac__variant">· {{ opt.result.variant }}</span>
            <span v-if="!opt.result.verified" class="ac__community" title="community-contributed, unverified">· community</span>
          </span>
          <span class="ac__metaright">
            <span class="t-num ac__w">{{ formatWeight(opt.result.weightMg, unit, { withUnit: false }) }} <span class="t-muted">{{ unit }}</span></span>
          </span>
        </template>
      </li>
    </ul>
    </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
.ac {
  position: relative;
  min-width: 0; /* allow the name cell to shrink so long names ellipsize */
}
.ac__input {
  width: 100%;
  color: var(--ink);
  /* long product names truncate with an ellipsis at rest; the full text scrolls
     into view while editing (focused) */
  text-overflow: ellipsis;
}
/* The menu's surface (background/radius/shadow/forced-colors border) comes from
   the shared .popover atom — this block only positions and sizes it.
   In an item row the anchor is the whole name CELL (.item__name overrides .ac to
   position:static), so left:0 = the row's left edge and the width can safely run
   wider than the input: 40rem, capped by the page column so it can never cross
   the row's right edge or the viewport. */
.ac__menu {
  position: absolute;
  left: 0;
  top: calc(100% + var(--space-1));
  z-index: var(--z-autocomplete);
  width: min(40rem, calc(min(100vw, var(--measure)) - 2 * var(--space-4)));
  /* inline padding only — the VERTICAL breathing room lives inside the scroller
     (its padding-block scrolls with the content), so scrolled rows travel all
     the way to the card's edge instead of clipping 8px early at a padding ledge */
  padding: 0 var(--space-2);
  /* clip those full-bleed rows (and the scrollbar's extremes) to the radius */
  overflow: hidden;
  /* the pop-in scales from where the menu hangs off the input (kebab: top right) */
  transform-origin: top left;
}
/* the scroller — INSIDE the card's inline padding, so the (thin, transparent-
   track) scrollbar sits inset from the edge, never over the rounded corners */
.ac__list {
  margin: 0;
  padding: var(--space-2) 0;
  list-style: none;
  /* cap at 10.5 ROWS (+ the resting top padding), not a round length: the half-
     cropped row at the fold is the scroll cue — glyphs sliced cleanly AT the
     card's visual edge (the .popover outline-not-border fix keeps the overflow
     clip flush; it was a 1px-inset ledge that made this crop read as broken).
     A full-text fold read as a complete list and left the card too tall. One row
     = 2×space-2 padding + a 1.5-line-height text-sm line; phrasing it in the
     same vars keeps the fold mid-row past the 1920px anchor where the type (and
     the rows) scale fluidly. The dvh cap keeps it on-screen on small devices
     (dvh tracks the collapsing mobile URL bar; vh line = older-browser fallback). */
  /* +2px: eye-tuned crop point (Ryan) — a hair more of the fold row's glyphs */
  max-height: min(calc(10.5 * (2 * var(--space-2) + 1.5 * var(--text-sm)) + var(--space-2) + 2px), 55vh);
  max-height: min(calc(10.5 * (2 * var(--space-2) + 1.5 * var(--text-sm)) + var(--space-2) + 2px), 50dvh);
  overflow-y: auto;
  /* never a horizontal bar: overflow-y alone computes overflow-x to auto, and with
     classic (always-shown) scrollbars the vertical bar narrows the rows, so any
     sub-pixel x-overflow painted a horizontal TRACK across the menu's bottom —
     stealing height so the fold crop landed mid-glyph with a dead band below it.
     Width pressure is the rows' ellipses' job, never a scrollbar's. */
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
  /* reaching the end of the list must not hand the swipe to the page */
  overscroll-behavior: contain;
}
@media (max-width: $bp-stack) {
  /* span the row's own edges — the content column — so the menu keeps the site's
     margins rather than bleeding to the viewport (per Ryan: never touch the edges) */
  .ac__menu {
    left: 0;
    right: 0;
    width: auto;
  }
}
.ac__opt {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2);
  cursor: pointer;
  font-size: var(--text-sm);
  /* concentric radius + hover tint are pinned on the shared .popover surface */
  border-radius: var(--popover-item-radius);
}
.ac__opt.is-active {
  background: var(--popover-hover);
}
.ac__name {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 0.4ch;
  overflow: hidden;
}
/* shrink order under width pressure: variant first, then brand, then the model
   (the most distinguishing part) clings on longest. Each truncates with its own
   ellipsis so a matched prefix stays visible. */
.ac__name > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ac__brand {
  flex: 0 100 auto;
  color: var(--ink-2);
}
.ac__model {
  flex: 0 1 auto;
  /* the model is the most distinguishing part — keep a readable floor so it never
     collapses to a couple of letters ("Enig…") while a long brand keeps its width;
     brand + variant (higher shrink factors) yield around it first. */
  min-width: 6ch;
}
.ac__variant {
  flex: 0 1000 auto;
  font-style: italic;
  color: var(--ink-3);
}
/* community/unverified marker — quiet; these rows already rank below the cited spine */
.ac__community {
  flex: 0 1 auto;
  white-space: nowrap;
  font-style: italic;
  color: var(--ink-3);
}
/* the characters that overlap what you've typed read bold — best-practice
   typeahead emphasis; the rest of the name stays normal weight */
.ac__hl {
  font-weight: 700;
  color: var(--ink);
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
</style>
