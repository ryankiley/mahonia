<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import {
  Cancel01Icon,
  ChevronDownIcon,
  DashedLine02Icon,
  Delete02Icon,
  Edit02Icon,
  ToolCaseIcon,
  MinusSignIcon,
  PlusSignIcon,
  ShirtIcon,
  UndoIcon,
} from "@hugeicons/core-free-icons";
import { WEIGHT_UNIT_OPTIONS } from "~/utils/unitOptions";
import type { Unit } from "~~/shared/types";
import { VAULT_NAME_MAX, type VaultEntry } from "~~/shared/vault";
import type { GearGlyph } from "~~/shared/gearGlyph";
import { formatPrice } from "~~/shared/money";
import { formatKcal, formatWeight, itemDisplayName } from "~~/shared/weights";
import { consumableIcon } from "~/utils/itemMarks";
import { counted } from "~~/shared/tidyText";
import { gearIcon, gearIconLabel } from "~/utils/gearIcons";
import { VAULT_KIT_QTY_MAX } from "~~/shared/vaultKit";
import { strongVaultRows } from "~~/shared/vaultSearch";

// One row of /gear: the name cell, the weight, the class mark and the trailing
// controls — or, for a REMOVED piece, the way back.
//
// Its own component because the page drew this row three times over (the flat list,
// a folder's list, the removed list), the same twenty-odd lines each, and a row copied
// three times is a row that drifts. The page keeps what differs between the three
// places: the folder list's press-to-drag lands on the root as a native listener, its
// dragging state as a class, and the removed list simply asks for the other shape.
//
// A KIT is this same row with a disclosure: a kit mark before the name, and a
// "Kit · 3 items" line that opens its items beneath it — indented and dimmed, the way
// a group opens on a list. Not a card: a kit and a
// piece are one kind of thing here, a row of your gear, and they keep one rhythm.
const props = defineProps<{
  entry: VaultEntry;
  unit: Unit;
  /** the row's own request is in flight (a remove, or a put-back) */
  busy?: boolean;
  /** the removed list's shape: the name and weight, and "Put back" in place of the controls */
  removed?: boolean;
  /** a kit's parts are showing — the page remembers it per kit, like a folder's collapse */
  open?: boolean;
  /** the kits a piece is in, by name — the page holds the names */
  kitNames?: string[];
  /** your gear, where an open kit's "Add an item" finds what to add */
  gear?: VaultEntry[];
  /** a change to this kit's items is saving: its controls wait */
  kitBusy?: boolean;
  /** "Make it a kit" was pressed for this piece: it shows the "Add an item" line, and
   *  the first item added makes it a kit */
  startKit?: boolean;
}>();
const emit = defineEmits<{
  edit: [];
  /** an icon picked from the row's own icon (null: back to the gear type's) */
  icon: [glyph: GearGlyph | null];
  remove: [];
  restore: [];
  /** a unit picked for this piece's weight (the list row's unit picker, on /gear) */
  unit: [unit: Unit];
  /** a menu on the row opened or closed — the kind's body lifts its clip while one is open */
  "overlay-toggle": [open: boolean];
  /** show or hide a kit's parts */
  toggle: [];
  /** open a part's own editor: a part is a piece of its own, not the kit's */
  "edit-part": [id: number];
  /** the kit's items as they should now be, each by id with how many, and its own
   *  weight — the whole set, the way the vault's kit op takes it */
  kit: [parts: { id: number; qty: number }[], ownWeightMg: number];
  /** "Make it a kit" given up on before an item went in */
  "cancel-kit": [];
  /** a kit's new name, typed on its open row */
  rename: [name: string];
  /** "Make it a single piece", pressed on an open kit */
  unkit: [];
}>();

const displayName = computed(() => itemDisplayName(props.entry.brand, props.entry.name, props.entry.variant));
// ---- a kit ----
// Its weight is DERIVED — its own plus its live items × count (kitWeightMg) — and shown
// plainly: the kit mark already says it is a set. A put-away item stays listed under
// it, marked, and stops counting.
const isKit = computed(() => props.entry.kind === "kit" && !props.removed);
const parts = computed(() => props.entry.parts ?? []);
// what the kit HOLDS, counting each item as many times as the kit has it: two mug lids
// and a stove is three items, not two lines (Ryan: "this doesn't seem to keep count")
const itemCount = computed(() => parts.value.reduce((n, p) => (p.removed ? n : n + p.qty), 0));
const removedParts = computed(() => parts.value.filter((p) => p.removed).length);

// ---- editing a kit's items, on the row -------------------------------------
// Ryan: "Do we need to do this in a modal?" — no: the items are right here once the
// kit is open, so they are changed here, each change saved as it is made (the unit
// picker's way). Every change sends the WHOLE set, which is what the vault's kit op
// takes. A kit keeps at least one item: emptying one would turn it back into a single
// piece at the weight it showed, which is not what taking the last item out means.
const refs = () => parts.value.map((p) => ({ id: p.id, qty: p.qty }));
const liveCount = computed(() => parts.value.filter((p) => !p.removed).length);
const editingItems = computed(() => (isKit.value && props.open) || (!!props.startKit && !props.removed));
function sendParts(next: { id: number; qty: number }[], own = props.entry.ownWeightMg ?? 0) {
  if (props.kitBusy) return;
  emit("kit", next, own);
}
// A kit holds no more of a piece than you own (the vault holds it to that too): + stops
// there, and says where the number lives.
const ownedOf = (id: number) => props.gear?.find((g) => g.id === id)?.owned ?? 1;
const partMax = (id: number) => Math.min(VAULT_KIT_QTY_MAX, ownedOf(id));
function stepPart(id: number, by: number) {
  sendParts(refs().map((r) => (r.id === id ? { id: r.id, qty: Math.min(partMax(id), Math.max(1, r.qty + by)) } : r)));
}
function dropPart(id: number) {
  sendParts(refs().filter((r) => r.id !== id));
}
const canDrop = (p: { removed?: boolean }) => !!p.removed || liveCount.value > 1;

// "Add an item": your other PIECES — not kits (one level deep), not this row, not one
// it already holds — by the picker's search, which offers real matches only.
const addQuery = ref("");
const addEl = useTemplateRef<HTMLInputElement>("addEl");
const addChoices = computed(() => {
  const q = addQuery.value.trim();
  if (!q || !editingItems.value) return [];
  const taken = new Set(parts.value.map((p) => p.id));
  const pool = (props.gear ?? []).filter((g) => g.kind !== "kit" && g.id !== props.entry.id && !taken.has(g.id));
  return strongVaultRows(pool, q, 6);
});
// The field stays live while a change saves (a disabled field drops its focus, and
// the next item is the next thing you type); Enter waits for the save to land, and
// the cursor is put back once it has.
let refocus = false;
function addPart(g: VaultEntry) {
  if (props.kitBusy) return;
  addQuery.value = "";
  refocus = true;
  sendParts([...refs(), { id: g.id, qty: 1 }]);
}
watch(
  () => props.kitBusy,
  (busy) => {
    if (busy || !refocus) return;
    refocus = false;
    nextTick(() => addEl.value?.focus());
  },
);
function onAddKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (addChoices.value[0]) addPart(addChoices.value[0]);
  } else if (e.key === "Escape") {
    if (addQuery.value) addQuery.value = "";
    else if (!isKit.value) emit("cancel-kit");
  }
}
// pressed "Make it a kit": the line is where you type next
watch(
  () => props.startKit,
  (on) => {
    if (on) nextTick(() => addEl.value?.focus());
  },
  { immediate: true },
);
const partName = (p: { brand?: string; name: string; variant?: string }) => itemDisplayName(p.brand, p.name, p.variant);
// each item wears its own icon, the one its row in your gear wears: read off the piece
// itself (its pick, else its gear type), and off the item's name for one put away
const partIcon = (p: { id: number; name: string }) => {
  const g = props.gear?.find((x) => x.id === p.id);
  return gearIcon(g?.commonName, g?.name ?? p.name, g?.icon);
};

// A kit is edited where it's shown, all of it: once it's open its name is a field, and
// "Make it a single piece" sits under its items — so a kit row has no Edit button and
// no dialog. Ryan: "maybe no notes for kits? i wanna delete that pencil icon". Saved on
// change (Enter or leaving the field); Escape puts the name back, and so does a blank.
function commitName(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = el.value.trim();
  if (!next || next === props.entry.name) {
    el.value = props.entry.name;
    return;
  }
  emit("rename", next);
}
function revertName(e: KeyboardEvent) {
  const el = e.target as HTMLInputElement;
  el.value = props.entry.name;
  el.blur();
}
// The unit THIS piece reads in: the one picked for it, else the page's. A list row's
// rowUnit, for the same reason: you buy gear labelled in whatever the maker chose, so a
// metric closet can hold a 3.8 oz stake set and still total in grams.
const rowUnit = computed<Unit>(() => props.entry.entryUnit ?? props.unit);
// What KIND of gear this is, as an icon: read off the gear type, or the name when the
// row has no type (shared/gearGlyph.ts). Null leaves the column empty rather than
// guessing — a wrong icon is worse than none.
const typeIcon = computed(() => gearIcon(props.entry.commonName, props.entry.name, props.entry.icon));
const typeLabel = computed(() => gearIconLabel(props.entry.commonName, props.entry.name, props.entry.icon));
// what "Match the gear type" would draw, in the icon popover
const autoIcon = computed(() => gearIcon(props.entry.commonName, props.entry.name));
// Calories, gated on the class exactly as computeTotals gates them — so what the row
// shows is what a list would count, rather than a number the totals ignore. A removed
// row shows its type only.
const kcal = computed(() =>
  !props.removed && props.entry.classification === "consumable" && props.entry.kcal ? props.entry.kcal : 0,
);
// The sub-line: the short facts about a piece of gear that aren't its weight. The
// note is not here — it is free text of any length, so it gets its own clamped line
// below. A removed row shows its type only, like the calories above.
const meta = computed(() => {
  const e = props.entry;
  const parts: string[] = [];
  if (e.commonName) parts.push(e.commonName);
  if (!props.removed && e.priceCents != null) parts.push(formatPrice(e.priceCents, e.currency));
  if (kcal.value) parts.push(`${formatKcal(kcal.value)} kcal`);
  return parts;
});
</script>

<template>
  <li class="vault__row" :class="{ 'vault__row--kit': isKit }">
    <div class="vault__line">
    <!-- the kind of gear, before its name: a fixed column whether or not this row has
         one, so every name starts at the same x. Decorative — the gear type says the
         same thing in words on the line below. A KIT wears the tool-case glyph
         here instead, so a set reads as one before you read a word of it — the same
         glyph the editor's gear pane puts on a kit; it is a set, not a kind of gear,
         so it has no icon to pick. -->
    <span v-if="isKit" class="vault__type" aria-hidden="true" title="Kit">
      <HugeiconsIcon :icon="ToolCaseIcon" :size="20" :stroke-width="2" />
    </span>
    <span v-else-if="removed" class="vault__type" aria-hidden="true">
      <HugeiconsIcon v-if="typeIcon" :icon="typeIcon" :size="20" :stroke-width="2" />
    </span>
    <!-- On a live row the icon is also the way to change it: pressing it opens the
         icon popover right there, and an empty slot is where you'd press to give a row
         one. The button is out of the tab order and hidden from assistive tech, because
         it is a shortcut to a field the row's Edit button already reaches — a second
         stop per row would double the keyboard walk down a page of a hundred. -->
    <GearIconPicker
      v-else
      class="vault__type"
      :model-value="entry.icon ?? null"
      :auto="autoIcon"
      :label="`Icon for ${displayName}`"
      @update:model-value="(g) => emit('icon', g)"
      @overlay-toggle="(o) => emit('overlay-toggle', o)"
    >
      <template #trigger="{ toggle, attrs }">
        <button
          type="button"
          class="vault__typebtn"
          :class="{ 'is-blank': !typeIcon }"
          tabindex="-1"
          v-bind="attrs"
          aria-hidden="true"
          :title="typeLabel ? `${typeLabel} · change icon` : 'Pick an icon'"
          @click="toggle"
        >
          <HugeiconsIcon v-if="typeIcon" :icon="typeIcon" :size="20" :stroke-width="2" />
          <!-- empty: Hugeicons' dashed square, the shape an icon would fill, quietly -->
          <HugeiconsIcon v-else :icon="DashedLine02Icon" :size="20" :stroke-width="2" />
        </button>
      </template>
    </GearIconPicker>
    <div class="gear__main">
      <!-- the title is the whole name: clipped, two catalog names that differ only at
           the end ("… Regular" / "… Long Wide") read identically, and this is the way
           to tell them apart without opening the dialog -->
      <input
        v-if="isKit && open"
        class="field gear__name vault__kitname"
        :value="entry.name"
        :maxlength="VAULT_NAME_MAX"
        :aria-label="`Name of ${displayName}`"
        autocomplete="off"
        spellcheck="false"
        @change="commitName"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        @keydown.esc="revertName"
      />
      <p v-else class="gear__name t-clip" :title="displayName">
        <span v-if="entry.brand" class="gear__brand">{{ entry.brand }}</span>
        <span>{{ entry.name }}</span>
        <span v-if="entry.variant" class="gear__variant"><span class="sep">·</span> {{ entry.variant }}</span>
      </p>
      <!-- the sub-line: the gear type, then what it cost, with the calories trailing
           for food. kcal is stored on every row that ever had one, but only counted
           on a consumable — so only a consumable shows it. -->
      <p v-if="meta.length" class="t-sm t-muted vault__meta">
        <template v-for="(part, i) in meta" :key="i"
          ><span v-if="i" class="sep"> · </span>{{ part }}</template
        >
      </p>
      <!-- your note, one line and clipped: it can be a paragraph, and a row is not
           where a paragraph goes. The dialog holds all of it. -->
      <p v-if="!removed && !isKit && entry.description" class="t-sm t-muted vault__note" :title="entry.description">
        {{ entry.description }}
      </p>
      <!-- a kit: how many items, as the control that shows them. Text-sized, so the
           row keeps the rhythm of its neighbours; the chevron is the shared .chev. -->
      <p v-if="isKit" class="t-sm vault__kitline">
        <button
          type="button"
          class="vault__kittoggle"
          :aria-expanded="!!open"
          :aria-label="`${open ? 'Hide' : 'Show'} the items in ${displayName}`"
          @click="emit('toggle')"
        >
          <span>Kit · {{ counted(itemCount, "item") }}</span>
          <span v-if="removedParts" class="t-muted"> · {{ removedParts }} removed</span>
          <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2.25" aria-hidden="true" />
        </button>
      </p>
      <!-- an item that is in a kit says which — one line, clipped. A piece in a kit is
           still a row of its own kind, so every view shows it. -->
      <p v-else-if="!removed && kitNames?.length" class="t-sm t-muted vault__kitline t-clip" :title="`In ${kitNames.join(', ')}`">
        In {{ kitNames.join(", ") }}
      </p>
    </div>
    <!-- The weight in this piece's own unit, and on a live row the unit is a picker:
         the list row's own (ItemRow), unit text and a quiet chevron, so one gesture
         means one thing across the two surfaces. -->
    <span class="t-num vault__weight">
      <!-- how many you own, when it's more than one, beside the weight it multiplies:
           three of the same bottle is one piece wearing ×3, not three rows. Before the
           figure, so the weights still line up down a right-aligned column. -->
      <span v-if="entry.owned" class="vault__owned" :title="`You own ${entry.owned}`">
        <span aria-hidden="true">×{{ entry.owned }}</span><span class="visually-hidden">{{ entry.owned }} owned, </span>
      </span>
      <template v-if="removed">{{ formatWeight(entry.weightMg, rowUnit) }}</template>
      <template v-else>
        <span>{{ formatWeight(entry.weightMg, rowUnit, { withUnit: false }) }}</span>
        <OptionMenu
          class="vault__unitwrap"
          :options="WEIGHT_UNIT_OPTIONS"
          :current="rowUnit"
          :label="`Weight unit for ${displayName}`"
          :title="`Unit for ${displayName}`"
          @overlay-toggle="(o) => emit('overlay-toggle', o)"
          @pick="(u) => emit('unit', u as Unit)"
        >
          <template #trigger="{ open }">
            <span class="t-sm t-muted">{{ rowUnit }}</span>
            <HugeiconsIcon
              :icon="ChevronDownIcon"
              class="chev vault__unitchev"
              :class="{ 'is-open': open }"
              :size="12"
              :stroke-width="2"
              aria-hidden="true"
            />
          </template>
        </OptionMenu>
      </template>
    </span>
    <template v-if="!removed">
      <!-- the editor's own marks, in a fixed column whether or not the row carries
           one — an auto column would size to the count and steal a different amount
           from the name on every row (the reason --item-col-actions is fixed too) -->
      <span class="vault__cls">
        <span v-if="entry.classification === 'worn'" class="item__mark item__mark--static" title="Worn">
          <HugeiconsIcon :icon="ShirtIcon" :size="16" :stroke-width="2" aria-hidden="true" />
          <span class="visually-hidden">Worn</span>
        </span>
        <span v-else-if="entry.classification === 'consumable'" class="item__mark item__mark--static" title="Consumable">
          <HugeiconsIcon :icon="consumableIcon(entry)" :size="16" :stroke-width="2" aria-hidden="true" />
          <span class="visually-hidden">Consumable</span>
        </span>
      </span>
      <div class="vault__actions">
        <!-- Edit, first in the cluster: the trailing icons are right-aligned, so
             the new one takes the open edge and the two you already know don't
             move — and it puts the destructive control furthest from the new
             arrival. -->
        <button
          v-if="!isKit"
          type="button"
          class="btn btn--icon btn--ghost vault__act ink-quiet"
          :title="`Edit ${displayName}`"
          :aria-label="`Edit ${displayName}`"
          @click="emit('edit')"
        >
          <HugeiconsIcon :icon="Edit02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
        <!-- glyph only, like every other row action on the site: the word was the
             widest thing in the row and said what the bin already says. The label
             lives on aria-label + title. -->
        <button
          type="button"
          class="btn btn--icon btn--ghost vault__act ink-quiet"
          :disabled="busy"
          :title="`Remove ${displayName}`"
          :aria-label="`Remove ${displayName} from My Gear`"
          @click="emit('remove')"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="16" aria-hidden="true" :stroke-width="2" />
        </button>
      </div>
    </template>
    <button
      v-else
      type="button"
      class="btn btn--quiet vault__act ink-quiet"
      :disabled="busy"
      :aria-label="`Put ${displayName} back in My Gear`"
      @click="emit('restore')"
    >
      <HugeiconsIcon :icon="UndoIcon" :size="14" aria-hidden="true" :stroke-width="2" /> Put back
    </button>
    </div>
    <!-- A kit's items, opened, and edited right here: each line is the piece itself
         (its name opens the piece's own dialog), its weight for the line, how many the
         kit holds between − and +, and remove. The controls sit under the row's own
         trailing cluster, so the weights stay in the kit's weight column. A put-away
         item stays listed and stops counting; it can only come out. A weight of the
         kit's own (from a group saved off a list whose heading had one) is a line of
         its own, and can come out too. Then "Add an item". -->
    <ul v-if="editingItems" class="vault__parts" :aria-label="`Items in ${displayName}`">
      <li v-for="p in parts" :key="p.id" class="vault__part" :class="{ 'vault__part--removed': p.removed }">
        <span class="vault__particon" aria-hidden="true">
          <HugeiconsIcon v-if="partIcon(p)" :icon="partIcon(p)!" :size="16" :stroke-width="2" />
        </span>
        <button
          v-if="!p.removed"
          type="button"
          class="vault__partname t-clip"
          :title="`Edit ${partName(p)}`"
          @click="emit('edit-part', p.id)"
        >{{ partName(p) }}</button>
        <span v-else class="vault__partname t-clip">{{ partName(p) }} <span class="vault__partgone">· removed</span></span>
        <span class="t-num vault__partweight">{{ formatWeight(p.weightMg * p.qty, unit) }}</span>
        <span class="vault__partctl">
          <!-- held out of sight, not dropped, when you own one and the kit holds one:
               both buttons would be dead, and the × keeps its column either way -->
          <span v-if="!p.removed" class="vault__partstep" :class="{ 'is-idle': p.qty <= 1 && partMax(p.id) <= 1 }">
            <button
              type="button"
              class="btn btn--icon btn--ghost ink-quiet"
              :disabled="kitBusy || p.qty <= 1"
              :aria-label="`One fewer ${partName(p)} in ${displayName}`"
              @click="stepPart(p.id, -1)"
            >
              <HugeiconsIcon :icon="MinusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
            </button>
            <span class="t-sm t-num vault__partcount" :aria-label="`${p.qty} in the kit`">{{ p.qty }}</span>
            <button
              type="button"
              class="btn btn--icon btn--ghost ink-quiet"
              :disabled="kitBusy || p.qty >= partMax(p.id)"
              :aria-label="`One more ${partName(p)} in ${displayName}`"
              :title="p.qty >= ownedOf(p.id) ? `You own ${ownedOf(p.id)}. Change how many in its Edit.` : undefined"
              @click="stepPart(p.id, 1)"
            >
              <HugeiconsIcon :icon="PlusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
            </button>
          </span>
          <button
            type="button"
            class="btn btn--icon btn--ghost ink-quiet"
            :disabled="kitBusy || !canDrop(p)"
            :aria-label="`Take ${partName(p)} out of ${displayName}`"
            :title="canDrop(p) ? `Take ${partName(p)} out of the kit` : 'A kit holds at least one item'"
            @click="dropPart(p.id)"
          >
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
        </span>
      </li>
      <li v-if="entry.ownWeightMg" class="vault__part">
        <span class="vault__particon" aria-hidden="true" />
        <span class="vault__partname">Its own weight</span>
        <span class="t-num vault__partweight">{{ formatWeight(entry.ownWeightMg, unit) }}</span>
        <span class="vault__partctl">
          <button
            type="button"
            class="btn btn--icon btn--ghost ink-quiet"
            :disabled="kitBusy"
            :aria-label="`Remove ${displayName}'s own weight`"
            title="Remove its own weight"
            @click="sendParts(refs(), 0)"
          >
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
        </span>
      </li>
      <li class="vault__partadd">
        <input
          ref="addEl"
          v-model="addQuery"
          class="field vault__partinput"
          placeholder="Add an item"
          :aria-label="`Add an item from your gear to ${displayName}`"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          @keydown="onAddKey"
        />
        <ul v-if="addChoices.length" class="vault__partchoices">
          <li v-for="g in addChoices" :key="g.id">
            <button type="button" class="vault__partchoice" @click="addPart(g)">
              <span class="t-clip">{{ itemDisplayName(g.brand, g.name, g.variant) }}</span>
              <span class="t-sm t-num t-muted">{{ formatWeight(g.weightMg, unit) }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="addQuery.trim()" class="t-sm t-muted vault__partnone">None of your gear matches. Add it to My Gear first.</p>
      </li>
      <!-- the way back: one piece weighing what the kit does, its items left as the
           pieces they are, with Undo on the page's toast -->
      <li v-if="isKit" class="vault__partfoot">
        <button type="button" class="btn btn--quiet t-sm ink-quiet vault__unkit" :disabled="kitBusy" @click="emit('unkit')">
          Make it a single piece
        </button>
      </li>
    </ul>
  </li>
</template>

<style scoped lang="scss">
/* --- the row --- */
/* de-outlined rows, separated by hairlines. The LINE is the flex row (name, weight,
   mark, controls); the row around it also holds a kit's opened parts, so the two are
   separate boxes. */
.vault__line {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
}
/* --- a kit --- */
/* the part count is the control that opens the kit — text-sized, so the row keeps the
   rhythm of its neighbours */
.vault__kitline {
  margin: 0;
}
.vault__kittoggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--ink-2);
  cursor: pointer;
  transition: color var(--spring-fade-dur) var(--spring-fade);
}
.vault__kittoggle:hover {
  color: var(--ink);
}
/* The parts: indented past the kit's mark, dimmed, one line each at the small size,
   so a six-part kit fits a 375px phone without wrapping. The right edge stops where
   the line's trailing cluster begins — the mark column and the three controls, with
   the line's gaps between — so each part's weight sits in the kit's own weight column. */
.vault__parts {
  /* + the unit picker's chevron and its gap (12 + 8), which sit after the row's figure
     and which a part's weight has none of; that 8 is the part grid's own column gap,
     so it isn't added here, or every item stops 8px short of the kit's "g" */
  --row-tail: calc(3 * var(--icon-btn) + var(--space-1) + 2 * var(--space-4) + 12px);
  list-style: none;
  margin: var(--space-1) 0 0;
  padding: 0 0 0 var(--gear-type-indent);
  color: var(--ink-2);
}
/* a kit's cluster is one button short — no Edit, since a kit is edited on its row —
   so its band is one button and its gap narrower, or the items' weights stop a
   button's width short of the kit's own "g" */
.vault__row--kit .vault__parts {
  --row-tail: calc(2 * var(--icon-btn) + 2 * var(--space-4) + 12px);
}
/* name, the line's weight in the kit's weight column, then the controls in the band
   the row's own trailing cluster takes, so × sits under the row's bin */
.vault__part {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto var(--row-tail);
  align-items: center;
  column-gap: var(--space-2);
}
/* the item's own icon, small and quiet before its name, so a kit reads as the pieces
   it holds rather than a list of words */
.vault__particon {
  display: inline-flex;
  color: var(--ink-3);
}
.vault__partctl {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-1);
}
.vault__partstep {
  display: inline-flex;
  align-items: center;
}
.vault__partstep.is-idle {
  visibility: hidden;
}
.vault__partcount {
  min-width: 2.5ch;
  text-align: center;
  color: var(--ink);
}
/* "Add an item": the name and weight columns' width, the field's own borderless box */
.vault__partadd {
  /* to the weight column's edge: the tail plus the grid gap before it */
  padding: var(--space-1) calc(var(--row-tail) + var(--space-2)) var(--space-1) calc(16px + var(--space-2));
  border-top: 1px solid var(--line);
}
/* the kit's name as a field: the row's own name, at its size and weight, that takes a
   caret — the editor's item names are fields the same way */
.vault__kitname {
  min-height: 0;
  padding: 0;
  font-weight: inherit;
}
/* quiet, on the items' left edge: a link-weight way out, not an action you reach for */
.vault__partfoot {
  padding-top: var(--space-1);
  padding-left: calc(16px + var(--space-2));
}
.vault__partinput {
  width: 100%;
}
.vault__partnone {
  margin: var(--space-1) 0 0;
}
/* its answers in flow under the field, a hairline list like the dialog's was */
.vault__partchoices {
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-2);
  overflow: hidden;
}
.vault__partchoices li + li {
  border-top: 1px solid var(--line);
}
.vault__partchoice {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.vault__partchoice:hover,
.vault__partchoice:focus-visible {
  background: var(--popover-hover);
}
.vault__part + .vault__part {
  border-top: 1px solid var(--line);
}
.vault__partname {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
span.vault__partname {
  cursor: default;
}
button.vault__partname:hover {
  color: var(--ink);
}
.vault__part--removed {
  color: var(--ink-3);
}
.vault__partgone {
  font-style: italic;
}
.vault__partweight {
  min-width: 5rem;
  text-align: right;
}
.vault__row {
  /* The editor's own item rhythm, to the pixel: .folder__items > * at --space-2.
     The anchor this used to cite ("Your lists", --space-4) is a page that no longer
     exists, and the reference that survives is the editor's, because these ARE that
     row on another surface — a name, a weight, a class mark, trailing icon buttons,
     hairlines between. Matching it exactly is also what makes the gap under a folder
     name the same here as it is in a list: the header's own --space-1 margin plus
     the first row's top padding, and a looser row here made that seam visibly
     different from the one two clicks away. */
  padding-block: var(--space-2);
}
.vault__row + .vault__row {
  border-top: 1px solid var(--line);
}
/* The picture column. Its box is the name's first line (1lh tall), so the glyph
   centres on that line however many lines the row grows, the same reasoning that
   puts the trailing marks at flex-start. Secondary ink: it supports the name, it
   doesn't outrank it. Pulled closer to the name than the row's gap, because the two
   are one object and the row's --space-4 is the gap BETWEEN objects. */
.vault__type {
  flex: none;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--gear-type-w);
  height: 1lh;
  margin-inline-end: calc(var(--space-2) - var(--space-4));
  color: var(--ink-2);
}
/* the slot as a button: no box of its own, the glyph just deepens under a pointer */
.vault__typebtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
/* An empty slot wears Hugeicons' dashed square in the faintest ink, where an icon
   would sit. It used to be a 14px dashed border drawn in CSS, whose dashes rendered
   unevenly at that size and read on a real page as an image that failed to load. */
.vault__typebtn.is-blank {
  color: var(--ink-ghost);
}
@media (hover: hover) and (pointer: fine) {
  .vault__typebtn:hover {
    color: var(--ink);
  }
}
.vault__typebtn:active {
  opacity: 0.7;
}
/* the name cell (.gear__main / .gear__name / .gear__brand / .gear__variant) comes
   from atoms/gear.scss — shared with the gear pane, which used to hand-mirror
   these rules. Only the page's own mobile stack below touches it. */
/* Your note, on one line and clipped. It is free text of any length and this is a
   row in a list that can run to hundreds — a two-line note here would set the
   rhythm of the whole page from its longest row. The full text is the title
   attribute and the dialog that edits it. */
.vault__note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* the count before the weight: quieter than the figure it multiplies, with a gap that
   keeps "×2" from reading as part of the number */
.vault__owned {
  margin-right: 0.75ch;
  color: var(--ink-3);
}
/* the unit picker beside the figure: content-sized, centred on its own text like the
   list row's .item__unitwrap, and as quiet at rest — a chevron on every row */
.vault__unitwrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: 0.25ch;
}
@media (pointer: coarse) {
  .vault__unitwrap :deep(.optmenu__btn) {
    min-height: var(--tap);
    margin-block: var(--tap-pull);
  }
}
@media (hover: hover) and (pointer: fine) {
  .vault__row:hover .vault__unitchev {
    color: var(--ink-2);
  }
}
.vault__unitwrap:focus-within .vault__unitchev {
  color: var(--ink-2);
}
.vault__weight {
  flex: none;
  color: var(--ink-2);
  /* a fixed column so the weights line up down the list instead of ragging with
     the name lengths beside them */
  min-width: 5rem;
  text-align: right;
}
/* A FIXED column whether or not the row carries a mark — an auto one would size to
   the count and steal a different amount from the 1fr name on every row, which is
   the same reason --item-col-actions is a fixed track.
   FIRST LINE, not the row's middle. `align-self: center` centres a 32px chip against
   the whole row, and a large share of these rows are two lines (a gear type, a
   calorie count) — so the mark sat visibly below the name and weight it belongs to.
   flex-start puts its layout box at the first line's top, and the chip's own
   --icon-pull (atoms/item.scss) recentres the 32px picture on that 1.45rem line. */
.vault__cls {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn);
  align-self: flex-start;
}
/* --space-1, matching .folder__actions above them: the row's controls were 16px
   apart while the folder header's three were 4px, so the two clusters read as
   different objects sitting in the same column.
   flex-start + --icon-pull for the same reason .vault__cls takes them: baseline
   alignment on a control with no text falls back to its bottom margin edge, which
   drifts down the moment a row grows a second line. */
.vault__actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  align-self: flex-start;
  margin-block: var(--icon-pull);
}
/* sizing + hover come from .btn--icon .btn--ghost; only the quiet resting ink is
   ours, matching the folder header's delete beside it */
.vault__act {
  flex: none;
}
/* touch: the row's controls take --tap-pull, whose layout box is exactly the 1.45rem text line — so
   enlarging the hit area for a thumb no longer stands a phone row 8px taller than
   the same row on a desktop. */
@media (pointer: coarse) {
  .vault__actions > * {
    margin-block: var(--tap-pull);
    align-self: center;
  }
  /* the trailing cluster grows to --tap, and the parts' weight column follows it */
  .vault__parts {
    --row-tail: calc(var(--icon-btn) + 2 * var(--tap) + var(--space-1) + 2 * var(--space-4) + 12px);
  }
  .vault__row--kit .vault__parts {
    --row-tail: calc(var(--icon-btn) + var(--tap) + 2 * var(--space-4) + 12px);
  }
  /* ...which makes the cluster's box exactly one text line already, so the desktop
     --icon-pull on the cluster would lift it a second time: 4.4px above the weight
     beside it on a phone's second line */
  .vault__actions {
    margin-block: 0;
  }
}
@media (max-width: $bp-stack) {
  /* name on its own line, weight + marks + controls beneath — nothing cramped */
  .vault__line {
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .gear__main {
    flex-basis: 100%;
  }
  /* the picture stays beside the name rather than taking a line of its own: the name
     takes the rest of the first line, and the row's own --space-2 is the gap here */
  .vault__type {
    margin-inline-end: 0;
  }
  .vault__type + .gear__main {
    flex-basis: calc(100% - var(--gear-type-indent));
  }
  /* With a line of its own the name gets two of them before it clips. One line at
     phone width cut long catalog names ("Sea to Summit Ether Light XT Insulated Air
     Mat · Regular Wide") back to their shared opening, so a row couldn't say which
     size it was, and a title has no hover to show it on a phone. Two lines, not
     unbounded: this is a list that can run to hundreds, and a stray four-line name
     would set the page's rhythm from its longest row (the note's reasoning, above). */
  .gear__name {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    white-space: normal;
  }
  /* A kit's item stacks the way the row above it does: its name on a line of its own,
     its weight and controls beneath. On one line the stepper and × left a phone's name
     four letters ("Soto …"), and two Soto pieces read the same. */
  .vault__part {
    grid-template-columns: 16px auto minmax(0, 1fr) auto;
    grid-template-areas:
      "icon name name name"
      ". weight . ctl";
    row-gap: var(--space-1);
    padding-top: var(--space-2);
  }
  .vault__particon {
    grid-area: icon;
  }
  .vault__partname {
    grid-area: name;
  }
  .vault__partweight {
    grid-area: weight;
    min-width: 0;
    text-align: left;
  }
  .vault__partctl {
    grid-area: ctl;
  }
  .vault__partadd {
    padding-right: 0;
  }
  .vault__parts {
    padding-right: 0;
    padding-left: var(--gear-type-indent);
  }
  .vault__weight {
    min-width: 0;
    text-align: left;
    /* the second line starts under the name, not under the icon: the icon column
       holds the first line alone, as it does on a wide screen */
    margin-inline-start: var(--gear-type-indent);
    /* a flex line, so the count can trade sides (below) */
    display: inline-flex;
    align-items: baseline;
  }
  /* Here the weights are LEFT-aligned, so a count in front would push this row's figure
     out of line with every other; it follows the weight instead ("65 g ×2"). */
  .vault__owned {
    order: 1;
    margin-right: 0;
    margin-left: 0.75ch;
  }
  .vault__actions {
    margin-left: auto;
  }
}
</style>
