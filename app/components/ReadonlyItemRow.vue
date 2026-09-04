<script lang="ts">
import type { Item as ItemT } from "~~/shared/types";

// one stable empty array for every leaf row — module scope so a large list
// doesn't mint a fresh identity per row
const NO_ITEMS: ItemT[] = [];
</script>

<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ShirtIcon } from "@hugeicons/core-free-icons";
import { personColor } from "~~/shared/people";
import type { Item, ListSnapshot } from "~~/shared/types";
import { effectiveClassification, formatKcal, formatWeight, rowDisplayMg, splitWornQty } from "~~/shared/weights";
import { itemQtyLabel } from "~~/shared/water";
import { consumableIcon } from "~/utils/itemMarks";

// The share views' row (/s + /l): name (a web-search link via <ItemName search>),
// amount, line weight — and its nested children, rendered the SAME way one level down
// (indented), exactly mirroring the editor. Deliberately its OWN component, not ItemRow
// with a flag — the read pages must not pull the editor graph (autocomplete, drag,
// useGearList, the modals) into their bundle just to render static text.
//
// `childrenByParent` is one groupItemsByParent pass per snapshot (ReadonlyListView),
// threaded to every row so rows don't each re-scan the whole item array.
const props = withDefaults(
  defineProps<{
    list: ListSnapshot;
    item: Item;
    childrenByParent: Map<string, Item[]>;
    /**
     * Rows kept on screen only as a label for a matching child, under a person
     * filter (ReadonlyListView computes the set). Such a row's own line is not in
     * this page's totals, so it prints no weight — the editor blanks the same cell
     * in CSS, which is the only way it can, since no row there sees the filter.
     */
    contextOnlyIds?: ReadonlySet<string>;
    nested?: boolean;
  }>(),
  { nested: false },
);

/** this row is scaffolding around a match, not one of the filtered person's own */
const isContextOnly = computed(() => !!props.contextOnlyIds?.has(props.item.id));

const effClass = computed(() => effectiveClassification(props.item, props.list.folders));
// one level of nesting: a nested row never renders its own children
const children = computed(() =>
  props.nested ? NO_ITEMS : (props.childrenByParent.get(props.item.id) ?? NO_ITEMS),
);
const isParent = computed(() => children.value.length > 0);
// a group shows its total (own + children); a leaf shows its own line weight
// (`children` holds exactly this row's children, so the sum is O(children))
const rowWeightMg = computed(() => rowDisplayMg(props.item, children.value));
// The unit the row was TYPED in, exactly as the editor and the packing view resolve it
// (ItemRow's rowUnit). Without this the same row read "32.5 oz" to the person who wrote
// it and "920 g" to everyone they shared it with — the feature is that a row keeps the
// unit you typed, and a shared list is still that row.
// A GROUP resolves the same way, though nothing was typed on it: there its entryUnit is
// the unit the owner picked for the TOTAL (ItemRow documents the double duty), and a
// group they set to ounces has to read in ounces here too, for the same reason.
const rowUnit = computed(() => props.item.entryUnit ?? props.list.displayUnit);

// The LINE's calories, on the same terms as the line's weight beside it: kcal is stored
// per unit, so this is kcal × qty. The totals bar already shows the list's calorie
// figure to a reader; without this the rows it was added up from stayed silent, and a
// shared food list could show "2,430 kcal" with nothing saying where it came from.
// Gated on the EFFECTIVE class, the same condition computeTotals counts under, so what
// a reader can see and what the total counted never disagree.
const lineKcal = computed(() =>
  effClass.value === "consumable" && props.item.kcal
    ? props.item.kcal * (props.item.qty || 0)
    : 0,
);
// The row's classification, as the MARK the editor lights rather than the word it
// used to trail the name with — same two icons, same lit chip, so a list reads the
// same shared as it does open in the editor, and the class scans down a column
// instead of hiding at the end of a name that may be long.
// A base row with a worn SPLIT counts as worn here exactly as it does in the editor
// (ItemRow's isWorn): the row has something on your body, so the column says so.
const splitWorn = computed(() => splitWornQty(props.item, effClass.value));
const isWorn = computed(() => effClass.value === "worn" || splitWorn.value > 0);
const isConsumable = computed(() => effClass.value === "consumable");
// the hover title, matching the editor's tooltip: a split names its count, since
// "Worn" alone would overstate a row that is mostly in the pack
const wornTitle = computed(() =>
  splitWorn.value > 0 ? `${splitWorn.value} of ${props.item.qty} worn` : "Worn",
);
// nested groups start CLOSED in a shared list — it reads compact (the group total is
// shown; expand to see the members). Local + per-view, NEVER persisted, matching
// ReadonlyFolderSection (the owner's editor collapse can't bleed into the share).
const collapsed = ref(true);
// The carrier, tagged only on the row that CLAIMS it (a child of a claimed group
// inherits silently — the editor's checklist face draws the same line), from the
// list's own people so the share reads exactly what the owner marked.
const rowPerson = computed(() =>
  props.item.personId ? props.list.people?.find((p) => p.id === props.item.personId) : undefined,
);
</script>

<template>
  <div class="ro-wrap">
    <div class="item-row item item--ro">
      <span class="item__roname t-clip" :class="{ 'item__roname--group': isParent }">
        <span class="item__ronametext" :class="{ 't-clip': isParent }"><ItemName :item="item" :group="isParent" search /><span v-if="lineKcal" class="t-sm item__class"> · {{ formatKcal(lineKcal) }} kcal</span><!--
          who carries it — the dot names the person in colour, the hidden text names
          them for flattened readers of this SSR'd page (the class-mark precedent)
        --><span v-if="rowPerson" class="t-sm item__carrier"><span class="swatch item__carrier-dot" :style="{ background: personColor(rowPerson) }" aria-hidden="true" />{{ rowPerson.name }}<span class="visually-hidden"> carries this</span></span></span>
        <!-- collapse a group of nested items — trails the name like the folder chevron.
             The name text truncates so a long group name never shoves the chevron off. -->
        <NestChevron v-if="isParent" :collapsed="collapsed" :label="item.name || 'group'" @toggle="collapsed = !collapsed" />
      </span>
      <!-- `item__qty--split` is what tells the page column this list needs the wider
           amount track (atoms/item.scss): the label grows from "×12" to "×12 · 11 worn"
           and the tight track can't hold it. -->
      <span class="t-num t-sm t-muted item__roqty" :class="{ 'item__qty--split': splitWorn }">{{ itemQtyLabel(item, effClass) }}</span>
      <!-- separate the qty and weight columns in the TEXT stream. On screen they're
           distinct grid cells, but flattened text (crawlers, LLMs, plain scrapers of
           this SSR'd share page) concatenates "×1" + "206" into "1206" — reading every
           weight ~1000 g heavy. A visually-hidden delimiter keeps them apart for those
           readers with no visual change (position:absolute → takes no grid cell). -->
      <span class="visually-hidden"> · </span>
      <!-- the zero placeholder keeps the unit slot, empty. Without it the dash hung off
           the cell's own right edge — 20px right of where every number in the column
           stops, since a number ends where the 2ch unit slot begins. It is standing in
           for the number, so it belongs in the number's place. -->
      <span class="t-num item__roweight"><template v-if="isContextOnly" /><template v-else-if="rowWeightMg > 0">{{ formatWeight(rowWeightMg, rowUnit, { withUnit: false }) }}<span class="t-muted item__wunit">{{ rowUnit }}</span></template><template v-else>—<span class="item__wunit" /></template></span>
      <!-- CLASSIFICATION — the editor's own marks, in the column the editor puts them
           in: a lit shirt for worn, a lit cookie for consumable (a droplet when the
           consumable is water — see consumableIcon), the shared .item__mark
           chip (atoms/item.scss). It replaces the word that used to trail the name,
           which hid the class at the end of a name that may be long and may truncate;
           down a column it scans, and a shared list now reads the way the same list
           reads open in the editor.
           The word survives as the mark's hidden label, so flattened text (crawlers,
           LLMs, plain scrapers of this SSR'd share page) still reads "· worn" exactly
           where it always did. Base rows leave the cell empty — same as the editor,
           where both toggles simply sit unlit. A WATER row does show its mark here,
           though the editor gives water no toggles: there the pair is hidden because
           water's class can't be edited, and nothing about a read row is editable. -->
      <span class="item__roclass">
        <span v-if="isWorn" class="item__mark item__mark--static item__romark" :title="wornTitle">
          <HugeiconsIcon :icon="ShirtIcon" :size="16" :stroke-width="2" aria-hidden="true" />
          <!-- a SPLIT already reads "×3 · 1 worn" in the amount cell, so a second
               "worn" here would only say it twice -->
          <span v-if="!splitWorn" class="visually-hidden"> · worn</span>
        </span>
        <span v-else-if="isConsumable" class="item__mark item__mark--static item__romark" title="Consumable">
          <HugeiconsIcon :icon="consumableIcon(item.name)" :size="16" :stroke-width="2" aria-hidden="true" />
          <span class="visually-hidden"> · consumable</span>
        </span>
      </span>
      <!-- the sub-line: the gear type (a quiet upright label, "Tent"/"Trail runners") with the
           owner's note trailing it inline in the italic caption voice. Either may be absent;
           with no common name the note shows alone, exactly as it did before this field. -->
      <p v-if="item.commonName || item.description" class="t-sm item__rosub">
        <span v-if="item.commonName" class="item__rogtype">{{ item.commonName }}</span
        ><span v-if="item.description" class="item__ronote">{{ item.commonName ? " · " : "" }}{{ item.description }}</span>
      </p>
    </div>
    <!-- nested items: the same read row, indented one level (their weights sum into the
         group total shown above). Collapsed by default in the share view. -->
    <div v-if="isParent" class="nestcollapse" :data-collapsed="collapsed || null">
      <div class="ro-nest nest-block">
        <ReadonlyItemRow
          v-for="child in children"
          :key="child.id"
          :list="list"
          :item="child"
          :children-by-parent="childrenByParent"
          :context-only-ids="contextOnlyIds"
          nested
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.item--ro {
  /* the grid scaffold (display / columns / align / gap) is the shared .item-row base
     (atoms/item.scss); the read row only feeds it the read column token. baseline align
     is the base default, so nothing else to set here.
     vertical padding comes from the row wrapper (.folder__items > *) so the rule lines
     between top-level items sit at a consistent rhythm. NESTED rows are spaced instead
     by .nest-block's own gap (atoms/item.scss) — deliberately, so a nested group reads
     as one quiet block rather than as more ruled rows. */
  --row-cols: var(--item-cols-ro);
  /* ROW gap 0, column gap the shared --item-gap: the sub-line below the name is a grid
     row here, so the row gap IS the caption gap — and any of it puts the sub-line
     further under the name than the editor does (there the caption hangs off the name
     field, whose own dead space is what the tuck cancels). At 0 the two line boxes meet,
     so the caption sits exactly one line under the name in read + edit alike. */
  --row-gap: 0 var(--item-gap);
}
/* the name cell clips to one line (.t-clip, on the element); the mobile rule below
   lets it wrap again */
/* a GROUP (parent) row: the name + trailing collapse chevron, mirroring the editor's
   ItemRow / a folder header. The name is a link so it hugs its text naturally. */
.item__roname--group {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  overflow: visible;
}
/* the name text truncates within the group flex so a long name never pushes the
   chevron off the row edge (the chevron is flex:none, always kept). .t-clip goes on
   the text span for a GROUP only: a leaf name's clip is the cell's own, and its mobile
   rule (below) has to be free to wrap it. */
/* the collapse chevron button + its rotate + touch tap target are the shared
   .item__nestcollapse / .item__nestchev recipe in atoms/folder.scss (one recipe with
   the folder header's), so a group chevron looks the same in the editor and the share
   views. */
/* the read-only name is a web-search link (look up / buy the gear) — see ItemName.vue,
   which owns the dotted underline + search icon so the underline wraps only the product
   name, not the variant. */
.item__roweight {
  text-align: right;
}
/* the classification cell — one chip wide, because a row is worn OR consumable and
   never both (one field, base stored as null), so there is never a second mark to
   reserve for. CENTRED rather than on the baseline for the same reason the editor's
   class cell is (ItemRow): the row aligns on the baseline, which lines up the TOPS of
   a 32px chip and the numbers beside it and leaves the glyph sitting high. */
.item__roclass {
  display: flex;
  align-self: center;
  align-items: center;
}
/* …but only --icon-btn to LOOK at, and pulled back onto its text line — both now in
   .item__mark--static (atoms/item.scss), which /gear's rows share. These three
   declarations were the second hand-copy of that box; the vault page would have been
   the third, which is when it stops being a hypothetical. */
/* the qty/amount label lives in the narrow 44px column; keep it on one line so a water
   row's volume ("1.75 L") never breaks between the number and its "L" unit. */
.item__roqty {
  white-space: nowrap;
}
/* the unit suffix gap (.item__wunit) is shared with the editor's rows — atoms/item.scss */
/* classification reads from its text label, not colour (chrome stays monochrome) */
.item__class {
  color: var(--ink-2);
}
/* the sub-line — a full-width caption line under the row holding the common name and,
   trailing it, the owner's note. Two voices within: the common name is an upright quiet
   LABEL (--ink-2); the note keeps the quietest italic aside voice (--ink-3). */
.item__rosub {
  grid-column: 1 / -1;
  /* no tuck here — the row's own gap is what sets this caption's distance from the name
     (see --row-gap above), unlike the editor's note, which tucks up into its name
     field's dead space */
  color: var(--ink-3);
}
.item__rogtype {
  color: var(--ink-2);
}
.item__ronote {
  color: var(--ink-3);
  font-style: italic;
}
/* the carrier tag is the shared .item__carrier atom (atoms/item.scss) — one
   recipe for this row and the editor's faces, per that file's header rule */
/* the nested block's thread-line container is the shared .nest-block atom
   (atoms/item.scss), rendered identically by the editor's ItemRow */

@media (max-width: $bp-stack) {
  /* two-line shape (mirrors the editor's mobile rows): the name takes its own line and
     wraps (never clips), and ×qty + weight sit together on a second line, flush-left —
     instead of the weight stranded out at the far-right margin. */
  .item--ro {
    /* two-line stack via the shared .item-row grid: the name takes row 1, ×qty · weight
       row 2, with the class mark ending that line (cell placements below). Only the
       columns, centre-align + gap change here.
       The mark gets a FIXED last track, so it lands at one x on every row: the two
       tracks before it are content-sized, and a mark that followed them directly would
       start wherever "×3 · 1 worn · 1,588 g" happened to measure — the drift the
       editor's mobile row already had to design out (ItemRow). */
    --row-cols: auto 1fr var(--icon-btn);
    --row-align: center;
    --row-gap: var(--space-1) var(--space-3); /* row-gap · column-gap */
  }
  .item__roname {
    grid-column: 1 / -1;
    grid-row: 1;
    white-space: normal;
    overflow: visible;
  }
  /* a GROUP name gets its own full-width line here (like a leaf name), so let it
     wrap and be fully read — the desktop nowrap/ellipsis (to keep the chevron on a
     fixed-width grid column) isn't needed once the name owns the row */
  .item__roname--group .item__ronametext {
    white-space: normal;
    overflow: visible;
  }
  /* the sub-line (gear type · note) takes the line directly under the name — it is the
     everyday word for that name, so it belongs against it, not under the numbers;
     ×qty · weight · mark drop to the third line. Mirrors the editor's rows. */
  .item__rosub {
    grid-row: 2;
  }
  .item__roqty {
    grid-column: 1;
    grid-row: 3;
  }
  /* the qty/weight cells' compact box metrics are shared with the editor's rows —
     atoms/item.scss */
  .item__roweight {
    grid-column: 2;
    grid-row: 3;
    justify-self: start;
    text-align: left;
  }
  .item__roclass {
    grid-column: 3;
    grid-row: 3;
  }
}
</style>
