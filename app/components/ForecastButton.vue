<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { SunCloud02Icon } from "@hugeicons/core-free-icons";
import type { ForecastLink } from "~~/shared/forecast";

// The forecast for one place on the route, as a link that opens the forecast site in a
// new tab: weather.gov inside the US, yr.no elsewhere (shared/forecast.ts). A LINK, never
// a fetch: nothing is asked of either site until the owner opens it.
//
// It sits in a waypoint row's delete column, in the rows that have nothing to delete:
// the camp at the end of each day, and the route's own end. The caller passes the cell's
// class (wprow__del), which lands on the Tooltip's root and so on the grid cell.
defineProps<{
  link: ForecastLink;
  /** names the place for a screen reader: "the camp at the end of day 2" */
  place: string;
}>();
</script>

<template>
  <Tooltip :text="`Forecast here, on ${link.site}`" preferred-placement="top">
    <a
      class="btn btn--icon btn--ghost forecastbtn"
      :href="link.href"
      target="_blank"
      rel="noopener noreferrer"
      :aria-label="`Forecast for ${place}, on ${link.site}`"
    >
      <HugeiconsIcon :icon="SunCloud02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
    </a>
  </Tooltip>
</template>

<style scoped lang="scss">
/* the quiet ink of the row's other marks, as the delete it stands in for */
.forecastbtn {
  color: var(--ink-3);
}
</style>
