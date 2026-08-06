<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowDownRight01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { categoryColor, nextFolderColor } from "~~/shared/categories";
import { formatDistance, type DisplayDistanceUnit } from "~~/shared/trailDistance";
import { GRADE_HARD_PCT, GRADE_MODERATE_PCT, gradeRuns, gradeSpread } from "~~/shared/gpx";

// The route's shape, cut into days.
//
// This is the app's FIRST inline SVG, and it is meant to stay the only one. `CategoryBar`
// covers everything that's a proportion of a whole; a profile isn't — it's a continuous
// surface sampled hundreds of times, whose meaning is in its slope. A flex track of
// column bars quantises slope away and costs hundreds of DOM nodes re-laid-out on every
// keystroke. So: one filled path per day, one ridge line per day, and nothing else.
//
// Two ceilings, so this doesn't become a charting layer:
//   1. The only elements inside are <title>, <desc>, <path>, <line> and <ellipse>. The
//      last two are the CURSOR — one interaction, not a chart primitive — and the list is
//      written down here precisely so widening it stays a decision rather than a drift.
//      (An <ellipse> rather than a <circle> because the box is stretched; see the dot.)
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
  /** the route's climb and drop, at FULL track resolution — see ListMeta.trailAscentM */
  ascentM?: number;
  descentM?: number;
}>();

// A unitless drawing space. X is 0–1000, Y is 0–200, and CSS decides the physical size —
// so there is no measurement, no ResizeObserver and no re-path on resize.
const VB_W = 1000;
const VB_H = 200;
// The cursor dot's radius, in viewBox units. Named because it appears twice — the X radius
// is counter-scaled off it — and the two must never drift apart into an oval.
const DOT_R = 8;
// The thresholds come from shared/gpx.ts, the same ones the shading bands by — so the
// number under the cursor and the colour under the cursor can never disagree about what
// "steep" means. There used to be a STEEP_PCT here saying 10 as well; two constants
// holding one idea is how a chart starts contradicting its own tooltip.
const bandOf = (pct: number) =>
  Math.abs(pct) >= GRADE_HARD_PCT ? "hard" : Math.abs(pct) >= GRADE_MODERATE_PCT ? "moderate" : "easy";

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
  // The ROUTE's length is the denominator, not the sum of the days — so a day covering 4
  // miles of a 20-mile route owns a fifth of the picture, and the sixteen miles nobody has
  // claimed yet stay visibly unclaimed. Sizing to the sum instead would stretch that one
  // day across the whole chart and quietly assert a plan that doesn't exist.
  const total = Math.max(
    props.totalDistanceM,
    props.dayDistancesM.reduce((s, d) => s + d, 0),
  );
  if (!(total > 0)) return props.profile.map(() => -1);
  const bounds: number[] = [];
  let run = 0;
  for (const d of props.dayDistancesM) {
    run += d;
    bounds.push(run / total);
  }
  return props.profile.map((_, i) => {
    const f = i / (props.profile.length - 1);
    // -1 = past the last assigned day: ground the itinerary hasn't reached
    const at = bounds.findIndex((b, k) => props.dayDistancesM[k]! > 0 && f <= b + 1e-9);
    return at;
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

/**
 * The gap between the day line and the difficulty beneath it, in viewBox units.
 *
 * The two encodings are separate claims — which day this is, and how hard it is — and they
 * were touching, which made the fill read as part of the line rather than as the ground
 * under it. A sliver of paper between them is what says "these are two things".
 *
 * viewBox units, so it scales with the container the way everything else in this drawing
 * does; at the chart's usual height it lands around 2–3 real pixels.
 */
const RIDGE_GAP = 7;

/** The polyline through a run of samples, and the same run closed down to the baseline. */
function pathsFor(idx: readonly number[]) {
  const pts = idx.map((i) => `${x(i).toFixed(1)},${y(props.profile[i]!).toFixed(1)}`);
  // the fill starts BELOW the ridge, clamped so a low point can't push it past the floor
  const under = idx.map(
    (i) => `${x(i).toFixed(1)},${Math.min(VB_H, y(props.profile[i]!) + RIDGE_GAP).toFixed(1)}`,
  );
  return {
    ridge: `M${pts.join("L")}`,
    fill: `M${x(idx[0]!).toFixed(1)},${VB_H}L${under.join("L")}L${x(idx[idx.length - 1]!).toFixed(1)},${VB_H}Z`,
  };
}

/**
 * TWO encodings on one mark, on two different marks so they can't muddy each other.
 *
 * The RIDGE carries the day — the same palette the itinerary uses, at full opacity, so
 * "which day is this" is answered by a line you can actually see rather than by a 22%
 * wash. The FILL carries how hard the ground is. They're separate lists on purpose: a
 * day owns one contiguous stretch, while grade flips band many times inside it, so
 * intersecting them would produce a segment per crossing of two unrelated boundaries.
 */
const dayRuns = computed(() => {
  if (props.profile.length < 2 || !props.dayDistancesM.length) return [];
  const owner = dayOfSample.value;
  const out: { ridge: string; color: string; index: number }[] = [];
  // one pass per day, then a final pass for the unassigned tail (-1)
  for (const d of [...props.dayDistancesM.map((_, i) => i), -1]) {
    const idx: number[] = [];
    for (let i = 0; i < props.profile.length; i++) if (owner[i] === d) idx.push(i);
    // reach back one sample so adjacent days meet rather than leaving a hairline of paper
    if (idx.length && idx[0]! > 0) idx.unshift(idx[0]! - 1);
    if (idx.length < 2) continue;
    out.push({
      ridge: pathsFor(idx).ridge,
      // unassigned ground is grey — a quiet surface, not a category colour, because it
      // is precisely the part of the route that has no day to belong to yet
      color: d === -1 ? "var(--ink-3)" : (dayColors.value[d] ?? "var(--cat-other)"),
      index: d,
    });
  }
  return out;
});

/** Where one day ends and the next begins — the sample index of each boundary. */
const dayCuts = computed(() => {
  const owner = dayOfSample.value;
  const cuts: number[] = [];
  for (let i = 1; i < owner.length; i++) if (owner[i] !== owner[i - 1]) cuts.push(i);
  return cuts;
});

/** Runs of like difficulty, filled — easy ground takes no hue at all. */
const gradeFills = computed(() => {
  if (props.profile.length < 2 || !(props.totalDistanceM > 0)) return [];
  return gradeRuns(props.profile, props.totalDistanceM).map((r, i) => {
    const idx: number[] = [];
    for (let k = r.from; k <= r.to; k++) idx.push(k);
    return { fill: pathsFor(idx).fill, band: r.band, key: i };
  });
});

// The spoken version carries the facts the shape encodes — a profile has no legend, so
// this has to be stronger than CategoryBar's bare "Weight by folder". Built from the same
// formatter the figures above use, so the two can't drift.
const description = computed(() => {
  // the SAME formatter the visible row uses — the spoken description and the printed
  // figures must not disagree about which unit the route is in
  const range = `from ${asHeight(lo.value)} to ${asHeight(hi.value)} ${heightUnit.value}`;
  const len = formatDistance(props.totalDistanceM, props.distanceUnit);
  const n = props.dayDistancesM.length;
  const climb = props.ascentM ? ` ${asHeight(props.ascentM)} ${heightUnit.value} of climb and ${asHeight(props.descentM ?? 0)} ${heightUnit.value} of descent.` : "";
  // The shading is the only place difficulty is stated, and a profile has no legend and
  // no <text> — so the spoken version has to carry it in figures. Proportions, not colour
  // names: "6.2 mi of it steep" is the fact; "red" is how it happens to be drawn.
  const spread = gradeSpread(props.profile, props.totalDistanceM);
  const hard = spread.hard > 0 ? `${formatDistance(Math.round(spread.hard), props.distanceUnit)} of it steep going` : "";
  const mod = spread.moderate > 0 ? `${formatDistance(Math.round(spread.moderate), props.distanceUnit)} moderate` : "";
  const going = [hard, mod].filter(Boolean).join(" and ");
  return `Elevation profile: ${len}, ${range}, across ${n} ${n === 1 ? "day" : "days"}.${climb}${going ? ` ${going}.` : ""}`;
});

/**
 * Heights read in feet on a miles list and metres on a kilometres one, which is how the
 * two systems are actually spoken — nobody says "12 miles and 900 metres of climb".
 *
 * The high and low come from the PROFILE rather than being stored, unlike the climb: a
 * peak is a sampled elevation, and resampling keeps those. It's the cumulative gain that
 * a coarse profile destroys, because that sums every wiggle.
 */
const heightUnit = computed(() => (props.distanceUnit === "mi" ? "ft" : "m"));
const asHeight = (m: number) =>
  props.distanceUnit === "mi"
    ? Math.round(m / 0.3048).toLocaleString()
    : Math.round(m).toLocaleString();

/**
 * The same three figures, formatted to be READ WHILE MOVING.
 *
 * Scrubbing is a continuous gesture and the readout was rewriting itself faster than
 * anyone can take a number off it. Three separate causes, and only one of them was
 * decimals:
 *
 * 1. The strings changed WIDTH. formatDistance strips a trailing zero, so "9.9 mi"
 *    became "10 mi" — one character narrower — and the whole label, which is centred on
 *    the cursor, jumped sideways at the moment you crossed 10. Fixed decimals keep the
 *    width constant so only the digits move.
 * 2. Elevation was quoted TO THE FOOT. Consumer GPS elevation is noisy to ±5–10 m, and
 *    the day rows already round feet to the nearest 10 for exactly this reason — the
 *    hover readout was the one place still claiming a precision nothing has, and it
 *    flickered through four digits a sample to do it.
 * 3. Grade at one decimal is mostly noise. It is a difference between two neighbouring
 *    samples, so its last digit is the least stable number on screen and the one the eye
 *    is drawn to. Whole percent says the same thing and holds still.
 *
 * Nothing here changes what is measured — only how many of its digits are asserted.
 */
const readDistance = (m: number) => {
  const per = props.distanceUnit === "mi" ? 1609.344 : 1000;
  return `${(m / per).toFixed(1)} ${props.distanceUnit}`;
};
const readHeight = (m: number) => {
  const step = props.distanceUnit === "mi" ? 10 : 5;
  const v = props.distanceUnit === "mi" ? m / 0.3048 : m;
  return (Math.round(v / step) * step).toLocaleString();
};
const readGrade = (pct: number) => {
  // Sign from the ROUNDED value, not the raw one: taking it from the raw grade printed
  // "−0%" for anything between −0.5 and 0, which asserts a direction and then denies it.
  const v = Math.round(pct);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}%`;
};

/**
 * Reading a point off the chart.
 *
 * The shape can't be measured — the vertical exaggeration is whatever the container is —
 * so hovering is how a grade or a height becomes readable at all, rather than guessed at
 * from the silhouette. That's also why this is a POINTER readout and not axis labels: it
 * answers "what is it here", which the picture genuinely knows, instead of implying the
 * whole shape can be measured, which it can't.
 */
const hoverIdx = ref<number | null>(null);
// width/height of the rendered box, so the dot can be counter-scaled back to a circle.
// Measured on hover (and on resize) rather than continuously — it only matters while a
// dot is on screen, and there is no ResizeObserver anywhere else in this component.
const aspect = ref(1);
const wrapRef = useTemplateRef<HTMLElement>("wrapRef");

/**
 * Touch needs THREE things a mouse doesn't, and the chart read as broken without them —
 * it only tracked when the finger happened to be right on the line.
 *
 * 1. The gesture has to be ours. `touch-action` defaults to `auto`, so the browser treats
 *    a drag as a possible page scroll, waits, and then fires `pointercancel` — the readout
 *    dies mid-scrub. The CSS claims horizontal movement and leaves `pan-y` alone, so a
 *    vertical swipe still scrolls the page: you can read the route without trapping the
 *    reader on a 56px-tall element.
 * 2. First contact has to read. There is no hover on touch, so `pointermove` alone means
 *    the first thing a tap does is nothing.
 * 3. The scrub has to survive leaving the box. The chart is short and a finger wanders;
 *    capturing the pointer keeps the reading alive until release instead of dropping out
 *    the moment it strays above the ridge.
 */
function onDown(e: PointerEvent) {
  if (e.pointerType !== "mouse") {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  onMove(e);
}
// A mouse never presses to read, so a release must not clear what hovering is still showing.
function onRelease(e: PointerEvent) {
  if (e.pointerType !== "mouse") hoverIdx.value = null;
}

function onMove(e: PointerEvent) {
  const el = wrapRef.value?.querySelector("svg");
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0)) return;
  aspect.value = r.height > 0 ? r.width / r.height : 1;
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  hoverIdx.value = Math.round(f * (props.profile.length - 1));
}
const onLeave = () => (hoverIdx.value = null);

/** The metres of route one sample covers — the run behind every grade below. */
const sampleRunM = computed(() =>
  props.profile.length > 1 ? props.totalDistanceM / (props.profile.length - 1) : 0,
);

const hover = computed(() => {
  const i = hoverIdx.value;
  if (i == null || !props.profile.length) return null;
  const ele = props.profile[Math.min(i, props.profile.length - 1)]!;
  // Grade across the samples EITHER SIDE, not the one ahead: a central difference is
  // steadier on noisy ground and doesn't lurch at the last point. At the ends it falls
  // back to the one neighbour that exists.
  const a = props.profile[Math.max(0, i - 1)]!;
  const b = props.profile[Math.min(props.profile.length - 1, i + 1)]!;
  const spanSamples = Math.min(props.profile.length - 1, i + 1) - Math.max(0, i - 1);
  const run = sampleRunM.value * spanSamples;
  const grade = run > 0 ? ((b - a) / run) * 100 : 0;
  return {
    x: (i / (props.profile.length - 1)) * VB_W,
    distanceM: Math.round((i / (props.profile.length - 1)) * props.totalDistanceM),
    ele,
    grade,
  };
});

const id = useId();
</script>

<template>
  <figure
    v-if="dayRuns.length"
    ref="wrapRef"
    class="tprofile-wrap"
    @pointermove="onMove"
    @pointerleave="onLeave"
    @pointerdown="onDown"
    @pointerup="onRelease"
    @pointercancel="onRelease"
  >
    <svg
      class="tprofile"
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      preserveAspectRatio="none"
      role="img"
      :aria-labelledby="`${id}-t ${id}-d`"
    >
      <title :id="`${id}-t`">Elevation profile</title>
      <desc :id="`${id}-d`">{{ description }}</desc>
      <!-- Difficulty first, underneath: the fills are the ground, the ridges are the
           itinerary drawn on top of it. -->
      <path
        v-for="g in gradeFills"
        :key="`g${g.key}`"
        :d="g.fill"
        class="tprofile__fill"
        :class="`is-${g.band}`"
      />
      <!-- A 1px cut at each day boundary, in paper — the same trick CategoryBar uses with
           a --space-px gap, so adjacent stretches always read as distinct. Sized by
           non-scaling-stroke, or the stretched viewBox would make it a fat smear. -->
      <line
        v-for="cut in dayCuts"
        :key="`c${cut}`"
        :x1="x(cut)"
        :x2="x(cut)"
        y1="0"
        :y2="VB_H"
        class="tprofile__cut"
        vector-effect="non-scaling-stroke"
      />
      <!-- vector-effect is MANDATORY here: with preserveAspectRatio="none" the stroke
           scales anisotropically, giving a fat horizontal ridge and a hairline vertical
           one. This is the single easiest thing to get wrong in this file. -->
      <path
        v-for="s in dayRuns"
        :key="s.index"
        :d="s.ridge"
        :stroke="s.color"
        class="tprofile__ridge"
        fill="none"
        vector-effect="non-scaling-stroke"
      />
      <!-- The cursor's own position on the route. A <line>, which is inside this file's
           stated ceiling of title/desc/path/line; non-scaling-stroke for the same reason
           the ridge needs it, or with preserveAspectRatio="none" a vertical rule renders
           as a hairline while a horizontal one renders fat. -->
      <line
        v-if="hover"
        :x1="hover.x"
        :x2="hover.x"
        y1="0"
        :y2="VB_H"
        class="tprofile__cursor"
        vector-effect="non-scaling-stroke"
      />
      <!-- Where the cursor meets the route. Radii are in viewBox units on a box stretched
           by preserveAspectRatio="none", so a <circle> would render as an ellipse. The
           screen radii are rx·(W/VB_W) and ry·(H/VB_H); setting them equal gives
           rx = ry·(VB_W/VB_H)/(W/H) — hence the counter-scale below. Getting it inverted
           renders a dot four times wider than tall, which is how this was first written. -->
      <ellipse
        v-if="hover"
        :cx="hover.x"
        :cy="y(hover.ele)"
        :rx="DOT_R * (VB_W / VB_H) / aspect"
        :ry="DOT_R"
        class="tprofile__dot"
      />
    </svg>
    <!-- The scale, in HTML rather than <text> inside the SVG: preserveAspectRatio="none"
         stretches glyphs horizontally, so any label drawn in there would distort with the
         container. Three marks only — the ends and the middle. A profile is a silhouette
         for recognition, and a full axis would invite reading distances off the shape,
         which the vertical exaggeration makes untrue. -->
    <!-- The readout FOLLOWS the pointer rather than rewriting the scale below. Swapping
         those figures meant the numbers you were reading changed under you while the ones
         you wanted appeared somewhere else entirely; a label at the cursor is read where
         you're already looking, and the scale stays a fixed frame of reference. -->
    <div
      v-if="hover"
      class="tprofile__read t-sm"
      :style="{ '--at': `${(hover.x / VB_W) * 100}%` }"
      aria-hidden="true"
    >
      <span>{{ readDistance(hover.distanceM) }}</span>
      <span>{{ readHeight(hover.ele) }} {{ heightUnit }}</span>
      <!-- ONE colour, and only when the grade is worth noticing. Up and down were two
           different hues, which quietly claimed that direction is the thing to read; it
           isn't. Steep is steep — a 15% descent is hard on the knees the way a 15% climb
           is hard on the lungs — so both take the same mark, and everything gentler is
           just a number. -->
      <!-- Banded on the ROUNDED grade, the one actually on screen. Banding the raw value
           printed "10%" in the moderate colour whenever the true grade was 9.6 — the
           number and its own colour disagreeing, which is worse than either being off. -->
      <span :class="`is-${bandOf(Math.round(hover.grade))}`">{{ readGrade(hover.grade) }}</span>
    </div>

    <figcaption class="tprofile__scale t-sm" aria-hidden="true">
      <span>0 {{ distanceUnit }}</span>
      <span>{{ formatDistance(Math.round(totalDistanceM / 2), distanceUnit) }}</span>
      <span>{{ formatDistance(totalDistanceM, distanceUnit) }}</span>
    </figcaption>

    <!-- What the shape can't be read off it. The vertical exaggeration is whatever the
         container is, so no height is measurable from the picture — these carry it in
         figures instead, which is the same division of labour the numbers above the chart
         already make. aria-hidden: <desc> says all of it, and better. -->
    <p class="tprofile__facts t-sm" aria-hidden="true">
      <span v-if="ascentM" class="tprofile__fact">
        <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" />
        {{ asHeight(ascentM) }} {{ heightUnit }}
      </span>
      <span v-if="descentM" class="tprofile__fact">
        <HugeiconsIcon :icon="ArrowDownRight01Icon" :size="14" :stroke-width="2" />
        {{ asHeight(descentM) }} {{ heightUnit }}
      </span>
      <span class="tprofile__fact tprofile__fact--range">
        {{ asHeight(lo) }}–{{ asHeight(hi) }} {{ heightUnit }}
      </span>
    </p>
  </figure>
</template>

<style scoped>
/* Stretches to its container and takes its height from CSS — the viewBox does the rest.
   Vertical exaggeration is therefore whatever the container is.

   This USED to say the mark may never carry a slope-derived claim — no gradient shading,
   no "steepest kilometre" — and it now does carry one, so here is the reversal and its
   reasoning rather than a silently deleted rule.

   The original argument was that a container-dependent vertical scale makes slope
   unreadable off the silhouette. That is still true, and it is an argument against asking
   the EYE to judge steepness from the shape. It is not an argument against colouring a
   grade the code has computed from the data: the shading doesn't ask you to measure the
   picture, it states a figure the picture happens to sit under. What stays banned is any
   claim the geometry alone would have to support. */
.tprofile-wrap {
  margin: 0;
}
.tprofile {
  display: block;
  width: 100%;
  height: clamp(56px, 9vw, 96px);
}
/* the ends sit hard against the mark's own edges, so each figure lines up with the
   point of the route it names rather than floating near it */
.tprofile__scale {
  display: flex;
  justify-content: space-between;
  margin-top: var(--space-1);
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.tprofile__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
  margin: var(--space-1) 0 0;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.tprofile__fact {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
/* The range carries no arrow, because it is a span rather than a movement — and that
   absence is the whole distinction. It used to also step back in colour, which put a
   figure at body size on 1.35:1 and made it unreadable rather than quiet. It inherits
   --ink-3 from .tprofile__facts like its siblings now. */
.tprofile__cursor {
  stroke: var(--ink-3);
  stroke-width: 1;
  stroke-dasharray: 2 3;
}
.tprofile-wrap {
  position: relative;
  cursor: crosshair;
  /* Horizontal movement belongs to the chart, vertical still scrolls the page. Without
     this the browser holds every touch-drag open as a possible scroll and then cancels the
     pointer stream, which is what made scrubbing feel like it only worked over the line. */
  touch-action: pan-y;
}
/* Tracks the cursor along the chart, centred on it, and clamped by the translate so the
   ends stay inside the figure instead of hanging off the column. pointer-events:none or
   it would sit under the pointer and fight the very move that positions it. */
.tprofile__read {
  position: absolute;
  top: 0;
  /* Clamped so the label never hangs off the column at the ends. The CURSOR is not
     clamped — the line and the dot live in the SVG and keep tracking the pointer all the
     way to both edges, so what stops at the end of the track is the label, not the
     reading. 6.5rem is half the label at its widest ("39.7 mi 5,906 ft -12.9%"); 5.5
     wasn't enough and it overhung the right edge by 8px. Measuring it properly would mean
     a layout read on every pointer move to fix an inset nobody can perceive. */
  left: clamp(6.5rem, var(--at), calc(100% - 6.5rem));
  transform: translate(-50%, calc(-100% - var(--space-1)));
  display: flex;
  gap: var(--space-2);
  padding: var(--space-px) var(--space-2);
  border-radius: var(--radius-2);
  background: var(--paper-2);
  color: var(--ink-2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
/* The SAME hues the shading uses, so the number and the band under the cursor agree —
   but not the same tokens, and that is deliberate rather than sloppy.
   
   --cat-* are validated as FILLS at ~3:1, and as text on --paper-2 in light mode the red
   measures 4.21:1 against AA's 4.5. So light mode drops the lightness at the same hue
   angle: the correlation a reader perceives is the HUE (it's the red one, it's the orange
   one), and lightness is free to move to clear the contrast floor. Dark mode already
   passes, so it stays near the fill values. */
.tprofile__read .is-hard {
  color: light-dark(oklch(0.5 0.22 25), oklch(0.68 0.25 25));
}
.tprofile__read .is-moderate {
  color: light-dark(oklch(0.52 0.14 62), oklch(0.8 0.18 62));
}
.tprofile__dot {
  fill: var(--ink);
  stroke: var(--paper);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
/* The ground's difficulty, strongest at the ridge and gone by the baseline.
 *
 * A MASK rather than a <linearGradient>, so the element ceiling at the top of this file
 * stands: no <defs>, no new SVG element, just CSS on a path that already existed. The
 * fade is relative to each run's own box, so it's densest at that stretch's high point
 * rather than tracking the ridge exactly — close enough to read as "under the line", and
 * the alternative costs a gradient definition per run.
 *
 * Easy ground takes no hue at all. Colour that fires everywhere isn't a signal. */
/* Solid, not a gradient.
 *
 * A fade was the first instinct and the wrong one at this size: the chart is 56–96px tall,
 * so a gradient spends most of its range on pixels that aren't there and leaves the hue
 * too weak to band by. A flat wash reads as ground, which is what it is.
 *
 * Easy ground is filled too, in the quietest ink there is. Left unfilled it put paper-
 * coloured gaps between the coloured runs and the surface broke into slivers — the absence
 * of difficulty has to be drawn for the presence of it to read. */
.tprofile__fill {
  fill: var(--ink-3);
  opacity: 0.1;
}
/* Orange for moderate, red for hard — adjacent hues, so the separation has to come from
   somewhere other than hue alone. It comes from WEIGHT: moderate sits noticeably lighter
   than hard, so the two read apart even for someone who can't tell the hues apart at all.
   Hue 62 rather than the palette's 50 for the same reason — every degree away from red's
   25 is a degree of separation bought cheaply. */
.tprofile__fill.is-moderate {
  fill: oklch(0.72 0.17 62);
  opacity: 0.22;
}
/* Red for hard, and the SAME red the hover readout marks a steep grade with — one idea,
   one hue. Yellow for moderate rather than orange: --cat-pack sits 28° from this in hue
   at a similar lightness, which is a classic red/green-deficient confusion pair, and a
   difficulty signal is exactly the wrong place to ask someone to tell those apart. */
.tprofile__fill.is-hard {
  fill: var(--cat-firstaid);
  opacity: 0.34;
}
/* the day boundary, cut in paper — 1px regardless of how the viewBox is stretched */
.tprofile__cut {
  stroke: var(--paper);
  stroke-width: 1;
}
.tprofile__ridge {
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}
</style>
