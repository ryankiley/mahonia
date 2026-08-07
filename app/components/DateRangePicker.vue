<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";

// A month grid for picking a trip's two dates.
//
// Replaces a pair of native <input type="date">. Those were correct but not ours:
// each browser draws its own control, none of them monochrome, and the pair made you
// think in two separate fields when the thing you are choosing is ONE span. A grid
// shows the span as a span.
//
// Everything here is calendar dates — `YYYY-MM-DD`, no time, no timezone. Dates are
// built and compared from parts, never through `new Date(iso)`, which parses as UTC
// midnight and lands a day early west of UTC.

const props = defineProps<{ start?: string; end?: string }>();
const emit = defineEmits<{ update: [{ start?: string; end?: string }] }>();

// ---- calendar-date helpers (all local, all part-based) ----
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function parts(s?: string): { y: number; m: number; d: number } | null {
  const x = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  return x ? { y: +x[1]!, m: +x[2]! - 1, d: +x[3]! } : null;
}
/** Sortable because the format is zero-padded and big-endian — no Date needed. */
const before = (a: string, b: string) => a < b;

const today = (() => {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth(), n.getDate());
})();

// which month the grid is showing — opens on the trip, else on this month
const cursor = ref(parts(props.start) ?? parts(props.end) ?? parts(today)!);
const viewY = computed(() => cursor.value.y);
const viewM = computed(() => cursor.value.m);

function step(by: number) {
  const m = viewM.value + by;
  const y = viewY.value + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  cursor.value = { ...cursor.value, y, m: mm };
  // Carry the tab stop into the month now on screen. `focused` is what gives ONE cell
  // tabindex="0"; leave it pointing at a day the grid no longer renders and every cell
  // gets -1, which drops the whole grid out of the tab order. Clamp the day so
  // 31 January → February lands on the 28th/29th rather than nowhere.
  const days = new Date(y, mm + 1, 0).getDate();
  const p = parts(focused.value);
  focused.value = iso(y, mm, Math.min(p ? p.d : 1, days));
}

// Sunday-first, which is both what JS weeks already are (getDay() 0 = Sunday, so the
// lead below needs no shift) and what the range label reads as: formatDateRange pins
// en-US and prints month-first, "August 12–15, 2026".
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const monthLabel = computed(() =>
  new Date(viewY.value, viewM.value, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
);

/** The cells to render: leading blanks to line up the 1st, then each day. */
const cells = computed(() => {
  const lead = new Date(viewY.value, viewM.value, 1).getDay(); // 0 = Sunday, and the grid starts there
  const days = new Date(viewY.value, viewM.value + 1, 0).getDate();
  const out: ({ iso: string; d: number } | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) out.push({ iso: iso(viewY.value, viewM.value, d), d });
  return out;
});

const inRange = (v: string) =>
  !!props.start && !!props.end && !before(v, props.start) && !before(props.end, v);

/**
 * One click at a time, and it always does something predictable:
 *  - no start yet, or a complete range already → begin a new range here
 *  - a start but no end → close the range (earlier than the start just moves it)
 * Deliberately NOT a two-field form: the second click is the end, and there is no
 * mode to be in or lose track of.
 */
function pick(v: string) {
  const { start, end } = props;
  if (!start || end) return emit("update", { start: v, end: undefined });
  if (before(v, start)) return emit("update", { start: v, end: undefined });
  emit("update", { start, end: v });
}

// ---- keyboard ----
// The grid is one tab stop (roving tabindex); arrows move a day at a time and cross
// month boundaries by re-cursoring, so a range never needs the mouse.
// Seeded with the SAME precedence the cursor uses above. Seeding from `start` alone
// left an end-only range (start cleared, end kept) opening on the end's month with
// the tab stop pointing at today in some other month — no rendered cell claimed
// tabindex="0", so the grid could not be tabbed into at all.
const focused = ref<string>(props.start ?? props.end ?? today);
const gridEl = useTemplateRef<HTMLElement>("gridEl");

// ---- the tracking pip ----
// One highlight that GLIDES to the day under the cursor, instead of every cell lighting
// its own hover. Same device as the topbar's mode toggle (.modetoggle__pill): a single
// absolutely-positioned box translated into place on the damped --ease, so the cursor
// tracks rather than blinks.
// It follows the POINTER while the pointer is in the grid and the KEYBOARD's day the
// rest of the time — so the two ways of moving around this grid share one cursor
// instead of each having its own, and arrowing after mousing picks up where you left
// off rather than jumping back.
const hovered = ref<string | null>(null);
function onOver(e: MouseEvent) {
  // Only days move it. Crossing a lead-in blank or the weekday letters leaves the pip
  // where it was rather than snapping it home mid-sweep.
  const day = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-iso]");
  if (day) hovered.value = day.dataset.iso!;
}

/** Grid coordinates of the day the pip sits on, or null if that day isn't on screen. */
const pip = computed(() => {
  const i = cells.value.findIndex((c) => c?.iso === (hovered.value ?? focused.value));
  // +1 row: the weekday letters are the grid's first row, and the pip shares the grid.
  return i < 0 ? null : { col: i % 7, row: Math.floor(i / 7) + 1 };
});

/**
 * Move the roving tab stop AND the real DOM focus together.
 *
 * Updating `focused` alone was half a roving tabindex: it moved which cell claims
 * tabindex="0", but setting tabindex="-1" on the element that currently holds focus
 * does not blur it. Focus stayed on the day you started from while the tab stop walked
 * away — so the ring never moved, and Enter fired the ORIGINAL day's handler. Crossing
 * a month boundary made that actively wrong rather than merely inert: the cells were
 * keyed by index, so Vue patched the still-focused button in place and it came back
 * showing a different date, which Enter then committed.
 *
 * Cells are keyed by their iso date now (see the template), so a month change replaces
 * nodes instead of repainting them, and the focus call below lands on the day named.
 */
async function moveFocus(v: string) {
  focused.value = v;
  const p = parts(v)!;
  cursor.value = { y: p.y, m: p.m, d: p.d };
  await nextTick();
  gridEl.value?.querySelector<HTMLElement>(`[data-iso="${v}"]`)?.focus();
}

function onKey(e: KeyboardEvent) {
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (delta == null) return;
  e.preventDefault();
  const p = parts(focused.value)!;
  const n = new Date(p.y, p.m, p.d + delta);
  void moveFocus(iso(n.getFullYear(), n.getMonth(), n.getDate()));
}

// The picker focuses ITSELF rather than being focused from outside. ListHead opens this
// behind a Lazy async component, so its own `await nextTick()` runs a tick before the
// grid exists and the cell lookup there found nothing on the very first open — the
// keyboard did nothing at all until you had opened the popover once before.
onMounted(() => {
  gridEl.value?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus();
});
</script>

<template>
  <div class="cal">
    <div class="cal__head">
      <button
        type="button"
        class="btn btn--icon btn--ghost cal__nav"
        aria-label="Previous month"
        @click="step(-1)"
      >
        <HugeiconsIcon :icon="ArrowLeft01Icon" :size="16" :stroke-width="2" />
      </button>
      <!-- polite, not assertive: the month changing is feedback on an action the
           reader just took, not an interruption -->
      <span class="t-sm cal__month" aria-live="polite">{{ monthLabel }}</span>
      <button
        type="button"
        class="btn btn--icon btn--ghost cal__nav"
        aria-label="Next month"
        @click="step(1)"
      >
        <HugeiconsIcon :icon="ArrowRight01Icon" :size="16" :stroke-width="2" />
      </button>
    </div>

    <div
      ref="gridEl"
      class="cal__grid"
      role="grid"
      :aria-label="monthLabel"
      @keydown="onKey"
      @mouseover="onOver"
      @mouseleave="hovered = null"
    >
      <!-- The cursor, and purely decorative: it marks where you are, and both things it
           tracks are already announced (the focused cell by focus, the range by
           aria-selected). It leads the cells so it can't intercept their clicks. -->
      <span
        v-if="pip"
        class="cal__pip"
        aria-hidden="true"
        :style="{
          translate: `calc(var(--icon-btn) * ${pip.col}) calc((var(--icon-btn) + var(--space-px)) * ${pip.row})`,
        }"
      />
      <span v-for="(w, i) in WEEKDAYS" :key="i" class="t-sm t-muted cal__wd" aria-hidden="true">{{ w }}</span>
      <!-- keyed by DATE, not index: a month change must replace these nodes, not
           repaint them in place under whatever still holds focus -->
      <template v-for="(c, i) in cells" :key="c ? c.iso : `pad-${i}`">
        <span v-if="!c" class="cal__pad" />
        <!-- aria-selected covers the whole span, not just its two ends: the days
             between are as selected as the days bounding them, and marking only the
             ends told a screen reader the opposite of what the grid shows -->
        <button
          v-else
          type="button"
          role="gridcell"
          :data-iso="c.iso"
          class="cal__day t-num"
          :class="{
            'is-start': c.iso === start,
            'is-end': c.iso === end,
            'is-between': inRange(c.iso) && c.iso !== start && c.iso !== end,
            'is-today': c.iso === today,
          }"
          :aria-selected="c.iso === start || c.iso === end || inRange(c.iso)"
          :tabindex="c.iso === focused ? 0 : -1"
          @click="pick(c.iso); moveFocus(c.iso)"
        >
          {{ c.d }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cal {
  display: grid;
  gap: var(--space-2);
  /* 7 columns of --icon-btn — the panel is sized by the grid rather than the grid
     stretching to fill a panel, so the cells stay square */
  width: calc(7 * var(--icon-btn));

  /* The range band, mixed from INK rather than picked off the surface ramp.
     --paper-2 was doing this job and couldn't: the grid sits on a .popover
     (--surface-float, #1f1f1f in dark), and --paper-2 is #151515 there — a shade
     DARKER than the surface under it. The selected span read as a faint dent instead
     of a fill. Ink over the surface holds in both schemes because --ink inverts with
     them, which is the same reason .popover mixes its own hover.
     Mixed into --surface-float rather than into `transparent`, so it is OPAQUE: the
     pip tracks underneath these cells, and a translucent band would let it show
     through as a travelling smudge. That ties the band to the surface the picker is
     used on — it has only ever been opened inside that popover, and the pip's
     containing grid is the same element, so the two can't be separated by accident. */
  --cal-band: color-mix(in oklab, var(--ink) 14%, var(--surface-float));
}
.cal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
}
.cal__month {
  font-weight: 600;
}
.cal__nav {
  color: var(--ink-3);
}
.cal__nav:hover {
  color: var(--ink);
}
/* Row gap only. A column gap slit the range band with a 2px gutter every day, so the
   span the ends round outward to make (below) arrived striped rather than continuous —
   seven tinted squares you had to read as a range instead of one bar you just see.
   Weeks still want their gap: without it a multi-week range collapses into a solid
   rectangle and stops looking like dates. */
.cal__grid {
  display: grid;
  grid-template-columns: repeat(7, var(--icon-btn));
  row-gap: var(--space-px);
  /* the pip's containing block. `isolate` keeps its z-index:-1 inside this grid —
     without a stacking context here that negative layer resolves against whatever
     ancestor happens to make one, and the pip would hunt for a surface to hide behind. */
  position: relative;
  isolation: isolate;
}
/* The tracking cursor. Sits UNDER the cells (z-index below their in-flow backgrounds)
   so the range paints over it — the pip slides behind the selected span and out the
   other side instead of veiling the dates it passes. */
.cal__pip {
  position: absolute;
  top: 0;
  left: 0;
  z-index: -1;
  inline-size: var(--icon-btn);
  block-size: var(--icon-btn);
  border-radius: var(--radius-2);
  background: color-mix(in oklab, var(--ink) 12%, transparent);
  pointer-events: none;
  /* damped --ease, never overshoot — same rule as the mode toggle's pill: a cursor
     that overshoots lands on the wrong day, however briefly */
  transition: translate var(--dur) var(--ease);
  will-change: translate;
}
.cal__wd {
  display: grid;
  place-items: center;
  block-size: var(--icon-btn);
  color: var(--ink-3);
}
.cal__day {
  display: grid;
  place-items: center;
  block-size: var(--icon-btn);
  padding: 0;
  border: 0;
  /* One step up from --radius-1, and deliberately not --radius-pill: a day cell is a
     square --icon-btn box, so pill draws a full circle, and a circle is the wrong
     shape for a SPAN — the caps swell away from the band between them and the range
     stops reading as one bar. 8px on a 32px box softens the corner without rounding
     the thing away. */
  border-radius: var(--radius-2);
  background: transparent;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--ink-2);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
/* no background here — the pip IS the hover, and a fill under it would double the mark
   and kill the sense that one cursor is moving */
.cal__day:hover {
  color: var(--ink);
}
/* The grid is one tab stop and the arrows walk it, so the focused day has to be
   visible — without a cue you are moving an invisible caret around a month. Only on
   :focus-visible, so a mouse click doesn't leave a ring behind. */
.cal__day:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
  border-radius: var(--radius-2);
}
/* today is MARKED, not selected — a ring rather than a fill, so it can't be mistaken
   for one end of the range */
.cal__day.is-today {
  box-shadow: inset 0 0 0 1px var(--line-2);
}
/* the span between the ends is tinted; the ends themselves are inverted ink. Same
   monochrome vocabulary as the row toggles: a filled ground means "on".
   After :hover, not before — the two rules are the same specificity, so source order
   is what decides them, and a day inside the range must keep reading as inside it
   while the pointer is over it. */
.cal__day.is-between {
  background: var(--cal-band);
  color: var(--ink);
  border-radius: 0;
}
/* The pip is masked while it's under the band, so an in-range day answers the pointer
   itself — by DEEPENING. Lightening would read as leaving the range, the one direction
   that means the opposite of what hovering a selected day is doing. */
.cal__day.is-between:hover {
  background: color-mix(in oklab, var(--ink) 22%, var(--surface-float));
}
.cal__day.is-start,
.cal__day.is-end,
.cal__day.is-start:hover,
.cal__day.is-end:hover {
  background: var(--accent);
  color: var(--accent-ink);
}
/* the ends round outward only, so a range reads as one continuous bar */
.cal__day.is-start {
  border-start-end-radius: 0;
  border-end-end-radius: 0;
}
.cal__day.is-end {
  border-start-start-radius: 0;
  border-end-start-radius: 0;
}
/* a single-day trip is both ends at once — it must stay fully rounded */
.cal__day.is-start.is-end {
  border-radius: var(--radius-2);
}
</style>
