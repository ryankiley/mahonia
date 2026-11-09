<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import {
  ChevronDownIcon,
  DashedLine02Icon,
  Delete02Icon,
  Edit02Icon,
  ShirtIcon,
} from "@hugeicons/core-free-icons";
import { WEIGHT_UNIT_OPTIONS } from "~/utils/unitOptions";
import type { Unit } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import type { GearGlyph } from "~~/shared/gearGlyph";
import { formatPrice } from "~~/shared/money";
import { formatKcal, formatWeight, itemDisplayName } from "~~/shared/weights";
import { consumableIcon } from "~/utils/itemMarks";
import { gearIcon, gearIconLabel } from "~/utils/gearIcons";

// One row of /gear: the name cell, the weight, the class mark and the trailing
// controls.
//
// Its own component because the page draws it in a kind's list, a flat list, and as a
// kit's items (VaultKitSection), and a row copied three times is a row that drifts. A
// kit's section swaps the trailing controls (the `actions` slot) for its own: how many
// it holds, and taking the piece out of the kit.
const props = defineProps<{
  entry: VaultEntry;
  unit: Unit;
  /** the row's own remove is in flight */
  busy?: boolean;
  /** the kits a piece is in, by name ("Cook kit, Fire kit"): a string, so it compares
   *  by value and a page render doesn't re-render every row */
  inKits?: string;
}>();
const emit = defineEmits<{
  edit: [];
  /** an icon picked from the row's own icon (null: back to the gear type's) */
  icon: [glyph: GearGlyph | null];
  remove: [];
  /** a unit picked for this piece's weight (the list row's unit picker, on /gear) */
  unit: [unit: Unit];
  /** a menu on the row opened or closed — the kind's body lifts its clip while one is open */
  "overlay-toggle": [open: boolean];
}>();

const displayName = computed(() => itemDisplayName(props.entry.brand, props.entry.name, props.entry.variant));
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
// shows is what a list would count, rather than a number the totals ignore.
const kcal = computed(() => (props.entry.classification === "consumable" && props.entry.kcal ? props.entry.kcal : 0));
// The sub-line: the short facts about a piece of gear that aren't its weight. The
// note is not here — it is free text of any length, so it gets its own clamped line
// below.
const meta = computed(() => {
  const e = props.entry;
  const parts: string[] = [];
  if (e.commonName) parts.push(e.commonName);
  if (e.priceCents != null) parts.push(formatPrice(e.priceCents, e.currency));
  if (kcal.value) parts.push(`${formatKcal(kcal.value)} kcal`);
  return parts;
});
</script>

<template>
  <li class="vault__row">
    <!-- the kind of gear, before its name: a fixed column whether or not this row has
         one, so every name starts at the same x. The gear type says the same thing in
         words on the line below.
         The icon is also the way to change it: pressing it opens the
         icon popover right there, and an empty slot is where you'd press to give a row
         one. The button is out of the tab order and hidden from assistive tech, because
         it is a shortcut to a field the row's Edit button already reaches — a second
         stop per row would double the keyboard walk down a page of a hundred. -->
    <GearIconPicker
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
      <p class="gear__name t-clip" :title="displayName">
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
      <!-- an item that is in a kit says which — one line, clipped. A piece in a kit is
           still a row of its own kind, so every view shows it. -->
      <p v-if="inKits" class="t-sm t-muted t-clip" :title="`In ${inKits}`">In {{ inKits }}</p>
    </div>
    <!-- The weight in this piece's own unit, and the unit is a picker:
         the list row's own (ItemRow), unit text and a quiet chevron, so one gesture
         means one thing across the two surfaces. -->
    <span class="t-num vault__weight">
      <!-- how many you own, when it's more than one, beside the weight it multiplies:
           three of the same bottle is one piece wearing ×3, not three rows. Before the
           figure, so the weights still line up down a right-aligned column. -->
      <span v-if="entry.owned" class="vault__owned" :title="`You own ${entry.owned}`">
        <span aria-hidden="true">×{{ entry.owned }}</span><span class="visually-hidden">{{ entry.owned }} owned, </span>
      </span>
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
    </span>
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
      <!-- a kit's item puts its count stepper first (#lead) and swaps the bin for
           taking it out of the kit (#remove); Edit is the row's either way -->
      <slot name="lead" />
      <!-- Edit, first in the cluster: the trailing icons are right-aligned, so
           the new one takes the open edge and the two you already know don't
           move — and it puts the destructive control furthest from the new
           arrival. -->
      <button
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
      <slot name="remove">
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
      </slot>
    </div>
  </li>
</template>

<style scoped lang="scss">
/* --- the row --- */
/* de-outlined rows, separated by hairlines: a flex row of name, weight, mark and
   controls. The rhythm and the hairline are the list folder's own (.folder__items > *,
   atoms/folder.scss), on the list VaultSection draws: these ARE the editor's item row
   on another surface, and matching its --space-2 to the pixel is what makes the gap
   under a heading the same here as in a list. */
.vault__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
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
  /* ...which makes the cluster's box exactly one text line already, so the desktop
     --icon-pull on the cluster would lift it a second time: 4.4px above the weight
     beside it on a phone's second line */
  .vault__actions {
    margin-block: 0;
  }
}
@media (max-width: $bp-stack) {
  /* name on its own line, weight + marks + controls beneath — nothing cramped */
  .vault__row {
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
