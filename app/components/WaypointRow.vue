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
/**
 * The route's own two ends, which are not the same sort of thing as a pin you dropped.
 *
 * They are properties of the ROUTE — where the track starts and where it stops — the way
 * the camp is a property of the day that ends there, and they get the camp's treatment:
 * their mark, and nothing to press. Offering the kind toggles here let you turn a
 * trailhead into a water source, which is not a thing a trailhead can become; offering
 * delete was worse, because the route grows its ends back from the geometry (see
 * ensureRouteEnds) and the button was quietly a lie.
 *
 * Still MOVABLE, on the map, by the same press-and-hold every pin answers to — which is
 * the case the plan wanted delete for anyway: you parked somewhere the track doesn't
 * start, so you drag the flag to where you actually left the car.
 */
const isRouteEnd = computed(() => props.waypoint.kind === "trailhead" || props.waypoint.kind === "end");
/** For the screen-reader names, where the label reads mid-sentence. */
const spoken = computed(() => meta.value.label.toLowerCase());
/** Padded, because these form a column down the day — see formatDistancePadded. */
const at = computed(() => formatDistancePadded(props.waypoint.alongM, props.distanceUnit));
/** The unpadded reading, for the spoken names where a column means nothing. */
const spokenAt = computed(() => formatDistance(props.waypoint.alongM, props.distanceUnit));
</script>

<template>
  <li class="wprow">
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
    <!--
      TWO TOGGLES, not a menu — the gear row's own convention for exactly this shape of
      choice. An item's classification is a small closed set rendered as icon buttons with
      the chosen one marked, and so is this: water or landmark. It costs one tap
      where the menu cost two, and the alternatives are visible rather than hidden behind a
      trigger, which is what makes a small set worth showing at all.

      Camp is NOT offered, though it is a real kind a pin can be — see
      PLACEABLE_WAYPOINT_KINDS for the argument: the itinerary already draws a camp at each
      day boundary, so a hand-placed one would put two kinds of camp on one map.

      The mark is .item__mark, the same atom, so the "this one is on" plate is one recipe
      wherever it appears. What is added here is HUE: the chosen glyph lights in its own
      category colour, the others stay quiet ink, so the row says which kind at a glance
      without needing the word beside it. The name field's placeholder still carries the
      word for anyone who wants it spelled out.
    -->
    <!-- The route's end wears its mark and offers nothing — see isRouteEnd. Boxed to a
         toggle's width so the flag lands on the pixel the first toggle's glyph does, the
         same trick the camp row plays. -->
    <span
      v-if="isRouteEnd"
      class="wprow__fixedkind"
      role="img"
      :aria-label="meta.label"
      :style="{ color: meta.color }"
    >
      <HugeiconsIcon :icon="meta.icon" :size="16" :stroke-width="2" aria-hidden="true" />
    </span>
    <div v-else class="wprow__kind" role="group" :aria-label="`Kind of the ${spoken} at ${spokenAt}`">
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
    <!-- Distance from the START OF THE ROUTE, not from the start of the day. It is the
         pin's actual stored position, it is what the map's own readouts use, and it stays
         the same number when the day boundaries move around it. -->
    <!-- Coordinate and distance are TWO CELLS, not one packed together. In one cell their
         widths add up differently on every row, so neither lines up with the row above —
         and a column that doesn't line up is just text at the end of a line. The coordinate
         leads, a step quieter: it answers "where exactly", asked once when you are copying
         it somewhere else, where the distance is what you scan the list by. -->
    <span class="t-sm wprow__coord">{{ coord }}</span>
    <span class="t-sm wprow__dist">{{ at }}</span>
    <!-- the cell stays either way, empty for the route's ends, so every column above and
         below still lines up through this row -->
    <button
      v-if="!isRouteEnd"
      type="button"
      class="btn btn--icon btn--ghost wprow__del"
      :aria-label="`Remove the ${spoken} at ${spokenAt}`"
      @click="c.removeWaypoint(waypoint.id)"
    >
      <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="2" />
    </button>
    <span v-else class="wprow__del" aria-hidden="true" />
  </li>
</template>

<style scoped lang="scss">
/* THE DAY'S COLUMNS, shared with the camp row beside it — the list sets --wprow-cols so
   every row in a day is cut the same way and kind, name, coordinate, distance and the
   delete button each line up down the list. A row with its own template only lines up with
   itself, which is how the camp ended up three columns wide against the pins' four. */
.wprow {
  display: grid;
  grid-template-columns: var(--wprow-cols);
  /* the list decides the arrangement — one line wide, two lines narrow */
  grid-template-areas: var(--wprow-areas, "name kind coord dist del");
  align-items: center;
  /* Both gaps come from the list too, for the same reason the columns do. The row gap only
     comes into play once the list stacks the name onto its own line on a narrow screen;
     --space-1 there keeps the name and its readings reading as one row. */
  gap: var(--space-1) var(--wprow-gap, var(--space-2));
}
/* the two sit tight against each other, as the gear row's classification pair does —
   they are one control with two settings, not two separate actions */
.wprow__kind {
  grid-area: kind;
  display: inline-flex;
  align-items: center;
  gap: var(--space-px);
}
.wprow__del {
  grid-area: del;
  /* the empty twin has no button box to size it, and the column has to hold open */
  width: var(--wprow-btn, var(--icon-btn, 32px));
}
/* one toggle's box, so a fixed kind's glyph sits where a chosen toggle's glyph sits */
.wprow__fixedkind {
  grid-area: kind;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--wprow-btn, var(--icon-btn, 32px));
}
/* quiet until chosen; .item__mark supplies the plate and the inline style the hue */
.wprow__kindbtn {
  color: var(--ink-3);
}
/* The list decides where these land — one line on a wide screen, two on a narrow one —
   so the pins and the night beneath them always wrap the same way. */
.wprow__name {
  min-width: 0;
  grid-area: name;
}
/* ONE SIZE AND ONE INK across the row's readings. They were set apart twice over — the
   coordinate a step smaller, then the distance a step darker — and neither difference was
   carrying a claim. These two cells are the same kind of thing said two ways: where the pin
   is. Ranking one above the other only breaks the baseline the column is read down. */
.wprow__coord,
.wprow__dist {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
  color: var(--ink-3);
}
.wprow__coord {
  grid-area: coord;
  /* stretched on one line, where text-align does the aligning; shrunk to its text and
     pushed left once the row wraps, so the two readings sit at opposite ends of it */
  justify-self: var(--wprow-coord-justify, stretch);
}
.wprow__dist {
  grid-area: dist;
}
</style>
