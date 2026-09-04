<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Delete02Icon, Edit02Icon, FolderIcon, ShirtIcon, UndoIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { formatKcal, formatWeight, itemDisplayName } from "~~/shared/weights";
import { consumableIcon } from "~/utils/itemMarks";

// One row of My Gear, in every seat the page shows one: the flat list, a folder's
// body, and the removed-gear disclosure (`removed`, which keeps the name and the
// weight and swaps the three actions for the one way back). The page owns the
// data, the requests and the drag; this owns the row's markup and reads the
// display name and the calorie figure ONCE — the three seats used to paste the
// same 60 lines and evaluate itemDisplayName six times per row.
const props = defineProps<{
  entry: VaultEntry;
  unit: Unit;
  /** every destination the move picker offers; live rows only */
  folderOptions?: { key: string; label: string }[];
  /** the row's remove request is in flight */
  removing?: boolean;
  /** the row is being dragged between folders */
  dragging?: boolean;
  /** the removed-gear seat: dimmed by the page, offers only "Put back" */
  removed?: boolean;
  /** the row's put-back request is in flight */
  restoring?: boolean;
}>();
const emit = defineEmits<{
  edit: [];
  remove: [];
  putBack: [];
  /** the move picker chose a folder (null = Unfiled) */
  move: [folderId: number | null];
  /** the move picker opened/closed — a folder lifts its collapse clip while it's up */
  overlayToggle: [open: boolean];
}>();

const displayName = computed(() => itemDisplayName(props.entry.brand, props.entry.name, props.entry.variant));
// Calories, gated on the class exactly as computeTotals gates them — so what the row
// shows is what a list would count, rather than a number the totals ignore.
const kcal = computed(() =>
  props.entry.classification === "consumable" && props.entry.kcal ? props.entry.kcal : 0,
);
</script>

<template>
  <li class="vault__row" :class="{ 'vault__row--dragging': dragging }">
    <div class="gear__main">
      <p class="gear__name">
        <span v-if="entry.brand" class="gear__brand">{{ entry.brand }}</span>
        <span>{{ entry.name }}</span>
        <span v-if="entry.variant" class="gear__variant"><span class="sep">·</span> {{ entry.variant }}</span>
      </p>
      <!-- the sub-line: the gear type, with the calories trailing it for food. kcal is
           stored on every row that ever had one, but only counted on a consumable —
           so only a consumable shows it. A removed row keeps just the type. -->
      <p v-if="removed && entry.commonName" class="t-sm t-muted vault__meta">{{ entry.commonName }}</p>
      <p v-else-if="!removed && (entry.commonName || kcal)" class="t-sm t-muted vault__meta">
        <span v-if="entry.commonName">{{ entry.commonName }}</span
        ><span v-if="entry.commonName && kcal" class="sep"> · </span
        ><span v-if="kcal">{{ formatKcal(kcal) }} kcal</span>
      </p>
    </div>
    <span class="t-num vault__weight">{{ formatWeight(entry.weightMg, unit) }}</span>
    <template v-if="removed">
      <button
        type="button"
        class="btn btn--quiet vault__act"
        :disabled="restoring"
        :aria-label="`Put ${displayName} back in My Gear`"
        @click="emit('putBack')"
      >
        <HugeiconsIcon :icon="UndoIcon" :size="14" aria-hidden="true" :stroke-width="2" /> Put back
      </button>
    </template>
    <template v-else>
      <!-- the editor's own marks, in a fixed column whether or not the row carries
           one — an auto column would size to the count and steal a different amount
           from the name on every row (the reason --item-col-actions is fixed too) -->
      <span class="vault__cls">
        <span v-if="entry.classification === 'worn'" class="item__mark item__mark--static" title="Worn">
          <HugeiconsIcon :icon="ShirtIcon" :size="16" :stroke-width="2" aria-hidden="true" />
          <span class="visually-hidden">Worn</span>
        </span>
        <span v-else-if="entry.classification === 'consumable'" class="item__mark item__mark--static" title="Consumable">
          <HugeiconsIcon :icon="consumableIcon(entry.name)" :size="16" :stroke-width="2" aria-hidden="true" />
          <span class="visually-hidden">Consumable</span>
        </span>
      </span>
      <div class="vault__actions">
        <!-- Edit, first in the cluster: the trailing icons are right-aligned, so the
             new one takes the open edge and the two you already know don't move — and
             it puts the destructive control furthest from the new arrival. -->
        <button
          type="button"
          class="btn btn--icon btn--ghost vault__act"
          :title="`Edit ${displayName}`"
          :aria-label="`Edit ${displayName}`"
          @click="emit('edit')"
        >
          <HugeiconsIcon :icon="Edit02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
        <!-- Move-to-folder: a quiet glyph opening the app's own picker. It used to
             render the folder's NAME on every row, which under a "Cook kit" heading
             meant every row repeating "Cook kit"; the heading already says where you
             are. The picker still names every destination when you open it, and it's
             the keyboard and touch path for moving gear. -->
        <OptionMenu
          class="vault__movewrap"
          trigger-class="btn btn--icon btn--ghost"
          :options="folderOptions ?? []"
          :current="String(entry.folderId ?? '')"
          :label="`Folder for ${displayName}`"
          :title="`Move ${displayName} to a folder`"
          @overlay-toggle="(o) => emit('overlayToggle', o)"
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
          :disabled="removing"
          :title="`Remove ${displayName}`"
          :aria-label="`Remove ${displayName} from My Gear`"
          @click="emit('remove')"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="16" aria-hidden="true" :stroke-width="2" />
        </button>
      </div>
    </template>
  </li>
</template>

<style scoped lang="scss">
/* de-outlined rows, separated by hairlines (the list they sit in is the page's
   .vault__list; the removed seat's dimming is the page's too, since it's about
   where the row is, not what it is) */
.vault__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
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
.vault__row--dragging {
  opacity: 0.4;
}
/* the name cell (.gear__main / .gear__name / .gear__brand / .gear__variant) comes
   from atoms/gear.scss — shared with the gear pane, which used to hand-mirror
   these rules. Only the mobile stack below touches it. */
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
  transition: color var(--dur) var(--ease);
}
.vault__act:hover {
  color: var(--ink);
}
/* the row's move-to-folder control: a glyph that shows the control exists,
   opening the app's own picker (OptionMenu) */
.vault__movewrap {
  position: relative;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn);
  min-height: var(--icon-btn);
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vault__movewrap:hover {
  color: var(--ink);
}
.vault__moveicon {
  pointer-events: none;
}
/* touch: the hand-rolled icon controls meet the --tap minimum like every
   .btn--icon does (controls.scss). The row's three controls take --tap-pull, whose
   layout box is exactly the 1.45rem text line — so enlarging the hit area for a
   thumb no longer stands a phone row 8px taller than the same row on a desktop. */
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
  .vault__weight {
    min-width: 0;
    text-align: left;
  }
  .vault__actions {
    margin-left: auto;
  }
}
</style>
