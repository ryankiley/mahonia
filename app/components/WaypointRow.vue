<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { ChevronDownIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import type { Waypoint, WaypointKind } from "~~/shared/types";
import { formatDistance, type DisplayDistanceUnit } from "~~/shared/trailDistance";
import { WAYPOINT_KIND_OPTIONS, waypointKindMeta } from "~/utils/waypointKinds";

// One pin, described.
//
// PLACING IS SPATIAL, DESCRIBING IS TEXTUAL. Where a pin sits is settled on the map by
// tapping the route; what it IS gets typed here, in a row beneath the day it falls in —
// the same inline shape an item row uses, and for the same reason: a panel floating over
// the terrain covers the thing you are trying to look at.
//
// Its own component because these rows appear once per day and once more for the ground no
// day has claimed, and a row copied across those two places is a row that drifts.
const props = defineProps<{ waypoint: Waypoint; distanceUnit: DisplayDistanceUnit }>();

const c = useGearList();

const meta = computed(() => waypointKindMeta(props.waypoint.kind));
/** For the screen-reader names, where the label reads mid-sentence. */
const spoken = computed(() => meta.value.label.toLowerCase());
const at = computed(() => formatDistance(props.waypoint.alongM, props.distanceUnit));
</script>

<template>
  <li class="wprow">
    <!--
      THE KIND IS A WORD, not just a glyph.
      It was icon-only, which made it the one control on the row you could only learn by
      pressing it — the same mistake the item row wrote down when it put the unit beside
      its chevron: "without it the unit was text that looked exactly like a caption, so the
      picker was only ever found by accident." A droplet with no word beside it is worse
      again, because it looks like a decoration rather than a control at all.
    -->
    <OptionMenu
      class="wprow__kind"
      :options="WAYPOINT_KIND_OPTIONS"
      :current="waypoint.kind"
      label="What is here"
      :trigger-label="`Kind of the ${spoken} at ${at}`"
      @pick="(k) => c.updateWaypoint(waypoint.id, { kind: k as WaypointKind })"
    >
      <template #trigger="{ open }">
        <HugeiconsIcon
          :icon="meta.icon"
          class="wprow__glyph"
          :style="{ color: meta.color }"
          :size="16"
          :stroke-width="2"
          aria-hidden="true"
        />
        <span class="wprow__kindname">{{ meta.label }}</span>
        <!-- the row-scale chevron, 12/2 for an exact 1px stroke — the same mark and the
             same size the item row's unit picker carries, so one gesture reads one way -->
        <HugeiconsIcon
          :icon="ChevronDownIcon"
          class="wprow__chev"
          :class="{ 'is-open': open }"
          :size="12"
          :stroke-width="2"
          aria-hidden="true"
        />
      </template>
    </OptionMenu>
    <!-- Unnamed is the normal case, not an omission: three water sources dropped in three
         taps are already useful, and the placeholder says what the pin is so an empty
         field never reads as a blank row. -->
    <input
      class="field wprow__name"
      :value="waypoint.label ?? ''"
      :placeholder="meta.label"
      maxlength="120"
      :aria-label="`Name for the ${spoken} at ${at}`"
      @change="(e) => c.updateWaypoint(waypoint.id, { label: (e.target as HTMLInputElement).value.trim() })"
    />
    <!-- Distance from the START OF THE ROUTE, not from the start of the day. It is the
         pin's actual stored position, it is what the map's own readouts use, and it stays
         the same number when the day boundaries move around it. -->
    <span class="t-sm t-muted wprow__at">{{ at }}</span>
    <button
      type="button"
      class="btn btn--icon btn--ghost"
      :aria-label="`Remove the ${spoken} at ${at}`"
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
.wprow__kind {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-2);
}
/* the glyph keeps its category hue — it is the same mark the pin on the map wears, and
   the pair is how you find a row's pin without reading either */
.wprow__glyph {
  flex: none;
}
.wprow__kindname {
  font-size: var(--text-sm);
  white-space: nowrap;
}
.wprow__chev {
  flex: none;
  color: var(--ink-3);
  transition: rotate var(--dur) var(--ease);
}
.wprow__chev.is-open {
  rotate: 180deg;
}
.wprow__name {
  min-width: 0;
}
.wprow__at {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
