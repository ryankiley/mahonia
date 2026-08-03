<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
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
  cursor.value = { ...cursor.value, y: viewY.value + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
}

// Monday-first, matching the en-GB formatting the range label uses. JS weeks start
// Sunday, hence the shift.
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const monthLabel = computed(() =>
  new Date(viewY.value, viewM.value, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
);

/** The cells to render: leading blanks to line up the 1st, then each day. */
const cells = computed(() => {
  const first = new Date(viewY.value, viewM.value, 1).getDay(); // 0 = Sunday
  const lead = (first + 6) % 7; // → Monday-first
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
const focused = ref<string>(props.start ?? today);
function onKey(e: KeyboardEvent) {
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (delta == null) return;
  e.preventDefault();
  const p = parts(focused.value)!;
  const n = new Date(p.y, p.m, p.d + delta);
  focused.value = iso(n.getFullYear(), n.getMonth(), n.getDate());
  cursor.value = { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() };
}
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

    <div class="cal__grid" role="grid" :aria-label="monthLabel" @keydown="onKey">
      <span v-for="(w, i) in WEEKDAYS" :key="i" class="t-sm t-muted cal__wd" aria-hidden="true">{{ w }}</span>
      <template v-for="(c, i) in cells" :key="i">
        <span v-if="!c" class="cal__pad" />
        <button
          v-else
          type="button"
          role="gridcell"
          class="cal__day t-num"
          :class="{
            'is-start': c.iso === start,
            'is-end': c.iso === end,
            'is-between': inRange(c.iso) && c.iso !== start && c.iso !== end,
            'is-today': c.iso === today,
          }"
          :aria-selected="c.iso === start || c.iso === end"
          :tabindex="c.iso === focused ? 0 : -1"
          @click="pick(c.iso); focused = c.iso"
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
  /* 7 columns of --icon-btn plus their gaps — the panel is sized by the grid rather
     than the grid stretching to fill a panel, so the cells stay square */
  width: calc(7 * var(--icon-btn) + 6 * var(--space-px));
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
.cal__grid {
  display: grid;
  grid-template-columns: repeat(7, var(--icon-btn));
  gap: var(--space-px);
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
  border-radius: var(--radius-1);
  background: transparent;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--ink-2);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.cal__day:hover {
  background: var(--paper-2);
  color: var(--ink);
}
/* today is MARKED, not selected — a ring rather than a fill, so it can't be mistaken
   for one end of the range */
.cal__day.is-today {
  box-shadow: inset 0 0 0 1px var(--line-2);
}
/* the span between the ends is tinted; the ends themselves are inverted ink. Same
   monochrome vocabulary as the row toggles: a filled ground means "on". */
.cal__day.is-between {
  background: var(--paper-2);
  color: var(--ink);
  border-radius: 0;
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
  border-radius: var(--radius-1);
}
</style>
