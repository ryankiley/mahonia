<script setup lang="ts">
// A labelled figure — a caption over a number, the unit a step back in ink. The .chip
// atom (atoms/chip.scss) is the stacking; this is the three spans the totals bar, the
// trip panel and the elevation profile had each written out, thirteen times between
// them. Only the spans: what sets a chip apart from its neighbours (the totals bar's
// hairlines, the panel's estimate tint) stays with the row that arranges it, as a
// modifier class that falls through onto the root.
defineProps<{
  label: string;
  /** already formatted — the caller owns the unit's precision and locale */
  value: string;
  /** drawn a step back; absent for a figure that carries its own ("4 h 20") */
  unit?: string;
}>();
</script>

<template>
  <span class="chip">
    <span class="t-label">{{ label }}</span>
    <!-- the space rides inside the muted span so Vue's whitespace condensing can't
         drop it; a space has no colour, so it reads exactly as it did outside -->
    <span class="t-num">{{ value }}<span v-if="unit" class="t-muted">{{ ` ${unit}` }}</span></span>
  </span>
</template>
