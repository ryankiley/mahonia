<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon, Delete02Icon, Edit02Icon, FolderIcon, Layers01Icon, ShirtIcon, UndoIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { formatPrice } from "~~/shared/money";
import { formatKcal, formatWeight, itemDisplayName } from "~~/shared/weights";
import { consumableIcon } from "~/utils/itemMarks";

// One row of /gear: the name cell, the weight, the class mark and the trailing
// controls — or, for a REMOVED piece, the way back.
//
// Its own component because the page drew this row three times over (the flat list,
// a folder's list, the removed list), the same twenty-odd lines each, and a row copied
// three times is a row that drifts. The page keeps what differs between the three
// places: the folder list's press-to-drag lands on the root as a native listener, its
// dragging state as a class, and the removed list simply asks for the other shape.
//
// A KIT is this same row with a disclosure: a kit mark before the name, its weight
// read as a sum ("= 540 g"), and a "Kit · 3 parts" line that opens its parts beneath
// it — indented and dimmed, the way a group opens on a list. Not a card: a kit and a
// piece are one kind of thing here, a row of your gear, and they keep one rhythm.
const props = defineProps<{
  entry: VaultEntry;
  unit: Unit;
  /** every destination the move control offers — "" is Unfiled (see the page) */
  folderOptions?: { key: string; label: string }[];
  /** the row's own request is in flight (a remove, or a put-back) */
  busy?: boolean;
  /** the removed list's shape: the name and weight, and "Put back" in place of the controls */
  removed?: boolean;
  /** a kit's parts are showing — the page remembers it per kit, like a folder's collapse */
  open?: boolean;
  /** the kits a piece is in, by name — the page holds the names */
  kitNames?: string[];
}>();
const emit = defineEmits<{
  edit: [];
  remove: [];
  move: [folderId: number | null];
  restore: [];
  /** the move menu opened or closed — the folder body lifts its clip while one is open */
  "overlay-toggle": [open: boolean];
  /** show or hide a kit's parts */
  toggle: [];
  /** open a part's own editor: a part is a piece in its own folder, not the kit's */
  "edit-part": [id: number];
}>();

const displayName = computed(() => itemDisplayName(props.entry.brand, props.entry.name, props.entry.variant));
// ---- a kit ----
// Its weight is DERIVED — its own plus its live parts × qty — so it reads "= 540 g", a
// sum rather than a figure someone typed. A put-away part stays listed under it,
// marked, and stops counting (kitWeightMg).
const isKit = computed(() => props.entry.kind === "kit" && !props.removed);
const parts = computed(() => props.entry.parts ?? []);
const partCount = computed(() => parts.value.reduce((n, p) => n + (p.removed ? 0 : p.qty), 0));
const removedParts = computed(() => parts.value.filter((p) => p.removed).length);
const partName = (p: { brand?: string; name: string; variant?: string }) => itemDisplayName(p.brand, p.name, p.variant);
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
    <!-- a kit's mark: the stacked-layers glyph, so a set reads as one before you read
         a word of it — the same glyph the editor's gear pane puts on a kit -->
    <span v-if="isKit" class="vault__kitmark" aria-hidden="true">
      <HugeiconsIcon :icon="Layers01Icon" :size="16" :stroke-width="2" />
    </span>
    <div class="gear__main">
      <p class="gear__name t-clip">
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
      <p v-if="!removed && entry.description" class="t-sm t-muted vault__note" :title="entry.description">
        {{ entry.description }}
      </p>
      <!-- a kit: how many parts, as the control that shows them. Text-sized, so the
           row keeps the rhythm of its neighbours; the chevron is the shared .chev. -->
      <p v-if="isKit" class="t-sm vault__kitline">
        <button
          type="button"
          class="vault__kittoggle"
          :aria-expanded="!!open"
          :aria-label="`${open ? 'Hide' : 'Show'} the parts of ${displayName}`"
          @click="emit('toggle')"
        >
          <span>Kit · {{ partCount }} {{ partCount === 1 ? "part" : "parts" }}</span>
          <span v-if="removedParts" class="t-muted"> · {{ removedParts }} removed</span>
          <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2.25" aria-hidden="true" />
        </button>
      </p>
      <!-- a piece that is part of a kit says which — one line, clipped -->
      <p v-else-if="!removed && kitNames?.length" class="t-sm t-muted vault__kitline t-clip" :title="`Part of ${kitNames.join(', ')}`">
        Part of {{ kitNames.join(", ") }}
      </p>
    </div>
    <span
      class="t-num vault__weight"
      :title="isKit ? 'The sum of its parts. Totals count the parts where they are filed, not here.' : undefined"
    ><template v-if="isKit">= </template>{{ formatWeight(entry.weightMg, unit) }}</span>
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
          type="button"
          class="btn btn--icon btn--ghost vault__act"
          :title="`Edit ${displayName}`"
          :aria-label="`Edit ${displayName}`"
          @click="emit('edit')"
        >
          <HugeiconsIcon :icon="Edit02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
        <!-- Move-to-folder: a quiet glyph opening the app's own picker — the same
             recipe as the folder header's sort control. It used to render the
             folder's NAME on every row, which under a "Cook kit" heading meant every
             row repeating "Cook kit"; the heading already says where you are. The
             picker still names every destination when you open it, and it's the
             keyboard and touch path for moving gear. -->
        <OptionMenu
          class="vault__movewrap"
          trigger-class="btn btn--icon btn--ghost"
          :options="folderOptions ?? []"
          :current="String(entry.folderId ?? '')"
          :label="`Folder for ${displayName}`"
          :title="`Move ${displayName} to a folder`"
          @overlay-toggle="(o) => emit('overlay-toggle', o)"
          @pick="(k) => emit('move', k ? Number(k) : null)"
        >
          <template #trigger>
            <HugeiconsIcon :icon="FolderIcon" class="vault__moveicon" :size="16" :stroke-width="2" aria-hidden="true" />
          </template>
        </OptionMenu>
        <!-- glyph only, like every other row action on the site: the word was the
             widest thing in the row and said what the bin already says. The label
             lives on aria-label + title. -->
        <button
          type="button"
          class="btn btn--icon btn--ghost vault__act"
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
      class="btn btn--quiet vault__act"
      :disabled="busy"
      :aria-label="`Put ${displayName} back in My Gear`"
      @click="emit('restore')"
    >
      <HugeiconsIcon :icon="UndoIcon" :size="14" aria-hidden="true" :stroke-width="2" /> Put back
    </button>
    </div>
    <!-- a kit's parts, opened. Each is the piece itself, filed in its own folder:
         tapping one edits it there. A put-away part stays listed and stops counting;
         the kit's own weight, when it has one, closes the list. -->
    <ul v-if="isKit && open" class="vault__parts" :aria-label="`Parts of ${displayName}`">
      <li v-for="p in parts" :key="p.id" class="vault__part" :class="{ 'vault__part--removed': p.removed }">
        <button
          v-if="!p.removed"
          type="button"
          class="vault__partname t-clip"
          :title="`Edit ${partName(p)}`"
          @click="emit('edit-part', p.id)"
        >{{ partName(p) }}</button>
        <span v-else class="vault__partname t-clip">{{ partName(p) }} <span class="vault__partgone">· removed</span></span>
        <span v-if="p.qty > 1" class="t-num vault__partqty">×{{ p.qty }}</span>
        <span class="t-num vault__partweight">{{ formatWeight(p.weightMg * p.qty, unit) }}</span>
      </li>
      <li v-if="entry.ownWeightMg" class="vault__part">
        <span class="vault__partname">Its own weight</span>
        <span class="t-num vault__partweight">{{ formatWeight(entry.ownWeightMg, unit) }}</span>
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
/* its mark sits on the first line beside the name, the mark column's recipe */
.vault__kitmark {
  flex: none;
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  height: 1lh;
  color: var(--ink-2);
}
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
  --row-tail: calc(4 * var(--icon-btn) + 2 * var(--space-1) + 2 * var(--space-4));
  list-style: none;
  margin: var(--space-1) 0 0;
  padding: 0 var(--row-tail) 0 calc(16px + var(--space-4));
  color: var(--ink-2);
}
.vault__part {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding-block: var(--space-1);
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
.vault__partqty {
  flex: none;
  color: var(--ink-3);
}
.vault__partweight {
  flex: none;
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
  color: var(--ink-3);
  transition: color var(--spring-fade-dur) var(--spring-fade);
}
.vault__act:hover {
  color: var(--ink);
}
/* the folder header's sort control at row scale: a glyph that shows the control
   exists, opening the app's own picker (OptionMenu) */
.vault__movewrap {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn);
  min-height: var(--icon-btn);
  color: var(--ink-3);
  transition: color var(--spring-fade-dur) var(--spring-fade);
}
.vault__movewrap:hover {
  color: var(--ink);
}
.vault__moveicon {
  pointer-events: none;
}
/* touch: the hand-rolled icon controls meet the --tap minimum like every
   .btn--icon does (controls.scss). The move control mirrors the folder header's
   sortwrap recipe, glyph bump included (atoms/folder.scss). The row's three
   controls take --tap-pull, whose layout box is exactly the 1.45rem text line — so
   enlarging the hit area for a thumb no longer stands a phone row 8px taller than
   the same row on a desktop. */
@media (pointer: coarse) {
  .vault__movewrap {
    width: var(--tap);
    min-height: var(--tap);
  }
  .vault__moveicon {
    width: var(--icon-touch);
    height: var(--icon-touch);
  }
  .vault__actions > * {
    margin-block: var(--tap-pull);
    align-self: center;
  }
  /* the trailing cluster grows to --tap, and the parts' weight column follows it */
  .vault__parts {
    --row-tail: calc(var(--icon-btn) + 3 * var(--tap) + 2 * var(--space-1) + 2 * var(--space-4));
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
  /* a kit's mark keeps its place beside the name, and the name gives up its width */
  .vault__row--kit .gear__main {
    flex-basis: calc(100% - 16px - var(--space-2));
  }
  /* stacked, the weight drops under the name, so the parts' weights just take the
     right edge */
  .vault__parts {
    padding-right: 0;
  }
  .vault__weight {
    min-width: 0;
    text-align: left;
  }
  .vault__actions {
    margin-left: auto;
  }
}
</style>
