<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import type { Waypoint, WaypointKind } from "~~/shared/types";
import { formatDistance, formatDistancePadded, type DisplayDistanceUnit } from "~~/shared/trailDistance";
import { WAYPOINT_KIND_META, WAYPOINT_KIND_OPTIONS, waypointKindMeta } from "~/utils/waypointKinds";

// One pin, described.
//
// PLACING IS SPATIAL, DESCRIBING IS TEXTUAL. Where a pin sits is settled on the map by
// tapping the route; what it IS gets typed here, in a row beneath the day it falls in —
// the same inline shape an item row uses, and for the same reason: a panel floating over
// the terrain covers the thing you are trying to look at.
//
// Its own component because these rows appear once per day and once more for the ground no
// day has claimed, and a row copied across those two places is a row that drifts.
const props = defineProps<{
  waypoint: Waypoint;
  distanceUnit: DisplayDistanceUnit;
  /** where it actually is, worked out from the route by the panel — never stored */
  coord?: string;
}>();

const c = useGearList();

const meta = computed(() => waypointKindMeta(props.waypoint.kind));
/** For the screen-reader names, where the label reads mid-sentence. */
const spoken = computed(() => meta.value.label.toLowerCase());
/** Padded, because these form a column down the day — see formatDistancePadded. */
const at = computed(() => formatDistancePadded(props.waypoint.alongM, props.distanceUnit));
/** The unpadded reading, for the spoken names where a column means nothing. */
const spokenAt = computed(() => formatDistance(props.waypoint.alongM, props.distanceUnit));
</script>

<template>
  <li class="wprow">
    <!--
      THREE TOGGLES, not a menu — the gear row's own convention for exactly this shape of
      choice. An item's classification is a small closed set rendered as icon buttons with
      the chosen one marked, and so is this: water, camp or landmark. It costs one tap
      where the menu cost two, and the alternatives are visible rather than hidden behind a
      trigger, which is what makes a small set worth showing at all.

      The mark is .item__mark, the same atom, so the "this one is on" plate is one recipe
      wherever it appears. What is added here is HUE: the chosen glyph lights in its own
      category colour, the others stay quiet ink, so the row says which kind at a glance
      without needing the word beside it. The name field's placeholder still carries the
      word for anyone who wants it spelled out.
    -->
    <div class="wprow__kind" role="group" :aria-label="`Kind of the ${spoken} at ${spokenAt}`">
      <Tooltip v-for="k in WAYPOINT_KIND_OPTIONS" :key="k.key" :text="k.label" preferred-placement="top">
        <button
          type="button"
          class="btn btn--icon btn--ghost wprow__kindbtn"
          :class="{ 'item__mark': waypoint.kind === k.key }"
          :aria-pressed="waypoint.kind === k.key"
          :aria-label="k.label"
          :style="waypoint.kind === k.key ? { color: WAYPOINT_KIND_META[k.key].color } : undefined"
          @click="c.updateWaypoint(waypoint.id, { kind: k.key as WaypointKind })"
        >
          <HugeiconsIcon :icon="k.icon" :size="16" :stroke-width="2" />
        </button>
      </Tooltip>
    </div>
    <!-- Unnamed is the normal case, not an omission: three water sources dropped in three
         taps are already useful, and the placeholder says what the pin is so an empty
         field never reads as a blank row. -->
    <input
      class="field wprow__name"
      :value="waypoint.label ?? ''"
      :placeholder="meta.label"
      maxlength="120"
      :aria-label="`Name for the ${spoken} at ${spokenAt}`"
      @change="(e) => c.updateWaypoint(waypoint.id, { label: (e.target as HTMLInputElement).value.trim() })"
    />
    <!-- Distance from the START OF THE ROUTE, not from the start of the day. It is the
         pin's actual stored position, it is what the map's own readouts use, and it stays
         the same number when the day boundaries move around it. -->
    <span class="wprow__at">
      <!-- The coordinate leads, a step quieter: it answers "where exactly", asked once
           when you are copying it somewhere else, where the distance is what you scan the
           list by — so the distance keeps the column against the delete button. -->
      <span v-if="coord" class="t-sm wprow__coord">{{ coord }}</span>
      <span class="t-sm t-muted">{{ at }}</span>
    </span>
    <button
      type="button"
      class="btn btn--icon btn--ghost"
      :aria-label="`Remove the ${spoken} at ${spokenAt}`"
      @click="c.removeWaypoint(waypoint.id)"
    >
      <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="2" />
    </button>
  </li>
</template>

<style scoped lang="scss">
.wprow {
  display: grid;
  /* kind · name · distance · remove — the name takes the slack, everything else is its
     own content, so the distances form a column down the list */
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-2);
}
/* the three sit tight against each other, as the gear row's classification pair does —
   they are one control with three settings, not three separate actions */
.wprow__kind {
  display: inline-flex;
  align-items: center;
  gap: var(--space-px);
}
/* quiet until chosen; .item__mark supplies the plate and the inline style the hue */
.wprow__kindbtn {
  color: var(--ink-3);
}
.wprow__name {
  min-width: 0;
}
.wprow__at {
  /* ONE LINE, not a stack. A row is a row: something set beneath it reads as a caption
     hanging off the row rather than as another of its columns, and it doubles the row's
     height for a figure nobody scans by.
     The coordinate goes BEFORE the distance so the distances still form a column down the
     list, hard against the delete button, which is what makes them comparable at all. */
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* ONE SIZE ACROSS THE ROW. The coordinate was a step smaller, which made it read as an
   annotation on the row rather than as one of its columns — and a row whose cells are set
   at two sizes has no baseline anyone can follow. It still steps back, but in INK only:
   colour separates importance without breaking the line. */
.wprow__coord {
  color: var(--ink-3);
}
</style>
