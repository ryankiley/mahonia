<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { Delete02Icon, DropletIcon, Flag02Icon, Flag03Icon, Location01Icon, TentIcon } from "@hugeicons/core-free-icons";
import type { Waypoint, WaypointKind } from "~~/shared/types";
import { formatDistance, type DisplayDistanceUnit } from "~~/shared/trailDistance";

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

const KIND_LABEL: Record<string, string> = {
  water: "Water", camp: "Camp", landmark: "Landmark", trailhead: "Trailhead", end: "End",
};
const KIND_ICON: Record<string, unknown> = {
  water: DropletIcon, camp: TentIcon, landmark: Location01Icon,
  trailhead: Flag02Icon, end: Flag03Icon,
};
// Only the three you PLACE. Trailhead and end come with the route and are singular by
// nature, so offering them here would let a route grow five finishes.
const KIND_OPTIONS = (["water", "camp", "landmark"] as const).map((k) => ({
  key: k, label: KIND_LABEL[k]!,
}));

const label = computed(() => KIND_LABEL[props.waypoint.kind] ?? "Landmark");
/** For the screen-reader names, where the label reads mid-sentence. */
const spoken = computed(() => label.value.toLowerCase());
const at = computed(() => formatDistance(props.waypoint.alongM, props.distanceUnit));
</script>

<template>
  <li class="wprow">
    <OptionMenu
      class="wprow__kind"
      :options="KIND_OPTIONS"
      :current="waypoint.kind"
      label="What is here"
      :trigger-label="`Kind of the ${spoken} at ${at}`"
      @pick="(k) => c.updateWaypoint(waypoint.id, { kind: k as WaypointKind })"
    >
      <template #trigger>
        <HugeiconsIcon :icon="KIND_ICON[waypoint.kind]" :size="16" :stroke-width="2" aria-hidden="true" />
      </template>
    </OptionMenu>
    <!-- Unnamed is the normal case, not an omission: three water sources dropped in three
         taps are already useful, and the placeholder says what the pin is so an empty
         field never reads as a blank row. -->
    <input
      class="field wprow__name"
      :value="waypoint.label ?? ''"
      :placeholder="label"
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
  /* icon · name · distance · remove — the name takes the slack, everything else is its
     own content, so the distances form a column down the list */
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-2);
}
.wprow__kind {
  display: inline-flex;
  color: var(--ink-2);
}
.wprow__name {
  min-width: 0;
}
.wprow__at {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
