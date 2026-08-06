<script setup lang="ts">
import { categoryColor, nextFolderColor } from "~~/shared/categories";
import { formatDistance, type DisplayDistanceUnit } from "~~/shared/trailDistance";

// The route's shape, cut into days.
//
// This is the app's FIRST inline SVG, and it is meant to stay the only one. `CategoryBar`
// covers everything that's a proportion of a whole; a profile isn't — it's a continuous
// surface sampled hundreds of times, whose meaning is in its slope. A flex track of
// column bars quantises slope away and costs hundreds of DOM nodes re-laid-out on every
// keystroke. So: one filled path per day, one ridge line per day, and nothing else.
//
// Two ceilings, so this doesn't become a charting layer:
//   1. The only elements inside are <title>, <desc>, <path> and <line>. Ever.
//   2. No <text>. preserveAspectRatio="none" stretches glyphs — every label lives in HTML.
//
// And one policy: M/L only, no bezier smoothing. A smoothed profile invents terrain
// between samples, which is the same refusal the burn-down makes by not drawing a line
// between two days.
const props = defineProps<{
  /** elevations in metres, evenly spaced BY DISTANCE (see shared/gpx.ts) */
  profile: number[];
  /** each day's distance in metres, in order — the cuts along the x axis */
  dayDistancesM: number[];
  distanceUnit: DisplayDistanceUnit;
  totalDistanceM: number;
}>();

// A unitless drawing space. X is 0–1000, Y is 0–200, and CSS decides the physical size —
// so there is no measurement, no ResizeObserver and no re-path on resize.
const VB_W = 1000;
const VB_H = 200;

const lo = computed(() => Math.min(...props.profile));
const hi = computed(() => Math.max(...props.profile));
// A flat route would divide by zero and, worse, draw a line through the middle of a box
// implying a range it doesn't have. Give it a floor and it sits low and calm instead.
const span = computed(() => Math.max(1, hi.value - lo.value));

const x = (i: number) => (i / (props.profile.length - 1)) * VB_W;
const y = (ele: number) => VB_H - ((ele - lo.value) / span.value) * VB_H * 0.92 - VB_H * 0.04;

/**
 * The day each sample belongs to, by cumulative distance — so a long day owns more of the
 * picture than a short one, which is the whole point of cutting it this way.
 */
const dayOfSample = computed(() => {
  const total = props.dayDistancesM.reduce((s, d) => s + d, 0);
  if (!(total > 0)) return props.profile.map(() => 0);
  const bounds: number[] = [];
  let run = 0;
  for (const d of props.dayDistancesM) {
    run += d;
    bounds.push(run / total);
  }
  return props.profile.map((_, i) => {
    const f = i / (props.profile.length - 1);
    const at = bounds.findIndex((b) => f <= b + 1e-9);
    return at === -1 ? bounds.length - 1 : at;
  });
});

/** One colour per day, from the palette built so consecutive picks sit far apart. */
const dayColors = computed(() => {
  const used: string[] = [];
  return props.dayDistancesM.map(() => {
    const key = nextFolderColor(used);
    used.push(key);
    return categoryColor(key);
  });
});

/** A filled area and a ridge per day, sharing a sample at each boundary so there's no gap. */
const segments = computed(() => {
  if (props.profile.length < 2 || !props.dayDistancesM.length) return [];
  const owner = dayOfSample.value;
  const out: { fill: string; ridge: string; color: string; index: number }[] = [];
  for (let d = 0; d < props.dayDistancesM.length; d++) {
    const idx: number[] = [];
    for (let i = 0; i < props.profile.length; i++) if (owner[i] === d) idx.push(i);
    // reach back one sample so adjacent days meet rather than leaving a hairline of paper
    if (idx.length && idx[0]! > 0) idx.unshift(idx[0]! - 1);
    if (idx.length < 2) continue;
    const pts = idx.map((i) => `${x(i).toFixed(1)},${y(props.profile[i]!).toFixed(1)}`);
    out.push({
      ridge: `M${pts.join("L")}`,
      fill: `M${x(idx[0]!).toFixed(1)},${VB_H}L${pts.join("L")}L${x(idx[idx.length - 1]!).toFixed(1)},${VB_H}Z`,
      color: dayColors.value[d] ?? "var(--cat-other)",
      index: d,
    });
  }
  return out;
});

// The spoken version carries the facts the shape encodes — a profile has no legend, so
// this has to be stronger than CategoryBar's bare "Weight by folder". Built from the same
// formatter the figures above use, so the two can't drift.
const description = computed(() => {
  const range = `from ${Math.round(lo.value)} m to ${Math.round(hi.value)} m`;
  const len = formatDistance(props.totalDistanceM, props.distanceUnit);
  const n = props.dayDistancesM.length;
  return `Elevation profile: ${len}, ${range}, across ${n} ${n === 1 ? "day" : "days"}.`;
});

const id = useId();
</script>

<template>
  <svg
    v-if="segments.length"
    class="tprofile"
    :viewBox="`0 0 ${VB_W} ${VB_H}`"
    preserveAspectRatio="none"
    role="img"
    :aria-labelledby="`${id}-t ${id}-d`"
  >
    <title :id="`${id}-t`">Elevation profile</title>
    <desc :id="`${id}-d`">{{ description }}</desc>
    <g v-for="s in segments" :key="s.index">
      <path :d="s.fill" :fill="s.color" class="tprofile__fill" />
      <!-- vector-effect is MANDATORY here: with preserveAspectRatio="none" the stroke
           scales anisotropically, giving a fat horizontal ridge and a hairline vertical
           one. This is the single easiest thing to get wrong in this file. -->
      <path
        :d="s.ridge"
        :stroke="s.color"
        class="tprofile__ridge"
        fill="none"
        vector-effect="non-scaling-stroke"
      />
    </g>
  </svg>
</template>

<style scoped>
/* Stretches to its container and takes its height from CSS — the viewBox does the rest.
   Vertical exaggeration is therefore whatever the container is, which is normal for a
   profile and the reason this mark may never carry a slope-derived CLAIM: no gradient
   shading, no "steepest kilometre". It is a silhouette for recognition; the numbers
   beside it carry the facts. */
.tprofile {
  display: block;
  width: 100%;
  height: clamp(56px, 9vw, 96px);
}
.tprofile__fill {
  opacity: 0.22;
}
.tprofile__ridge {
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}
</style>
