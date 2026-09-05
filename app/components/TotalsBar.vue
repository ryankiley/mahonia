<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";
import { classMark } from "~/utils/itemMarks";
import type { Classification, ListSnapshot, Totals, Unit } from "~~/shared/types";
import { carriedIsDistinct, formatKcal, formatWeight, totalsChips } from "~~/shared/weights";
import { KCAL_PER_DAY_GENEROUS, KCAL_PER_DAY_LIGHT, foodPlan } from "~~/shared/foodPlan";

const props = withDefaults(
  defineProps<{
    list: ListSnapshot;
    totals: Totals;
    /**
     * Whether to draw the big figure.
     *
     * The editor turns it OFF, because it renders one Headline of its own above all three
     * views — the same element whether you are looking at weight or distance, so the
     * number changes without the figure unmounting and re-counting. The read views keep
     * it, having no such switcher and only one number to show.
     *
     * Same shape as TrailProfile's `facts`: the composing page decides, because only it
     * knows what else is on screen.
     */
    headline?: boolean;
  }>(),
  { headline: true },
);

const emit = defineEmits<{
  "set-unit": [Unit];
}>();

// the classification breakdown chips — which show (and when a lone "Base" is
// noise) is a judgment about the data, shared with the social-card image via
// totalsChips so the two renderings can't drift
const chips = computed(() => totalsChips(props.totals));

// THE LEGEND. These three chips are the only place the app writes the class names out
// in full, and the rows below them mark the same three with a picture and nothing else
// — a shirt, a cookie (a droplet on water), a backpack — so the two vocabularies never
// met. Someone opening a share link has never seen the editor's toggles, and `title=`
// doesn't exist on a phone; the word and its glyph sitting together here is the whole
// explanation, built out of a row that was already on the page.
// Only the PARTITION carries a mark. Carried / Calories / Per day are a roll-up and a
// different quantity — already set apart by their hairline — and a glyph on them would
// undo the one distinction this row is at pains to draw.
const CHIP_CLASS: Record<string, Classification> = {
  Base: "base",
  Worn: "worn",
  Consumable: "consumable",
};
const chipMark = (label: string) => classMark(CHIP_CLASS[label] ?? "base");

// "Carried" — base + consumable, the weight actually on your back. The three chips
// above partition the total, so this is the one figure here that's a ROLL-UP of two of
// them rather than a slice, and it's the number you check against what a pack carries
// comfortably. A breakdown that shows only the slices and the skin-out total leaves
// you to add two of them in your head.
//
// carriedIsDistinct (shared/weights.ts) decides whether it's worth showing — the same
// call the Markdown export makes, so the two can't drift.
const showCarried = computed(() => carriedIsDistinct(props.totals));

const kcalDisplay = computed(() => formatKcal(props.totals.kcalTotal));

// Calories PER DAY — the figure that answers "is there enough food in here", which
// the raw total can't: 9,000 kcal is a feast for a weekend and starvation for a week.
// Null (and silent) unless the list carries both calories and a date range; see
// shared/foodPlan.ts for why the arithmetic stops here rather than modelling burn.
const plan = computed(() => foodPlan(props.totals, props.list));
const planTip = computed(() => {
  const p = plan.value;
  if (!p) return "";
  const span = `${kcalDisplay.value} kcal across ${p.days} ${p.days === 1 ? "day" : "days"}.`;
  // Named as a rule of thumb, and phrased as a range rather than a target — the band
  // is a sanity check on the arithmetic, not a recommendation for a body.
  //
  // Deliberately no colour on the chip for a "light" reading. The band is a rule of
  // thumb, not a verdict on a body — a flat five-mile day on 1,800 kcal is somebody
  // having a nice time, and painting that red would be the app inventing a certainty
  // it doesn't have. The number beside the range is the whole signal.
  const band =
    p.reading === "typical"
      ? `That's inside the ${formatKcal(KCAL_PER_DAY_LIGHT)}–${formatKcal(KCAL_PER_DAY_GENEROUS)} kcal a day people commonly plan for walking with a pack.`
      : `People commonly plan ${formatKcal(KCAL_PER_DAY_LIGHT)}–${formatKcal(KCAL_PER_DAY_GENEROUS)} kcal a day for walking with a pack.`;
  return p.perDayDistance ? `${span} ${p.perDayDistance} a day. ${band}` : `${span} ${band}`;
});
</script>

<template>
  <div class="totals">
    <div class="totals__main">
      <div v-if="props.headline" class="totals__headline">
        <!-- no "Total" label: the big figure makes it implicit. the figure starts
             zeroed (not a placeholder line) so nothing reflows when the first
             weighted item lands — the number just counts up. -->
        <!-- The whole total is the trigger — tapping the number to change units is the
             affordance, and it survives the swap. What changes is what opens: OUR
             picker instead of a transparent native <select> laid over the figure. -->
        <OptionMenu
          class="totals__amount"
          align="baseline"
          :options="WEIGHT_UNIT_OPTIONS"
          :current="list.displayUnit"
          label="Weight unit"
          title="Change unit"
          @pick="(u) => emit('set-unit', u as Unit)"
        >
          <template #trigger="{ open }">
            <AnimatedCount class="t-num totals__big" :value="formatWeight(totals.totalMg, list.displayUnit, { withUnit: false })" />
            <span class="totals__uc" aria-hidden="true">
              <span class="totals__unit">{{ list.displayUnit }}</span>
              <!-- stroke 2.25, not the app-wide 2: at size 16 it renders an exact
                   1.5px stroke (crisp 3 device px at 2x), so the chevron holds its
                   weight beside the display-size figure -->
              <HugeiconsIcon :icon="ChevronDownIcon" class="totals__chev" :class="{ 'is-open': open }" :size="16" :stroke-width="2.25" />
            </span>
          </template>
        </OptionMenu>
      </div>
    </div>

    <!-- always rendered: the bar holds a blank rail at zero so it never reflows in.
         the chips stay per-category — they pop in as each class first gains weight -->
    <div class="totals__breakdown">
      <!-- only the categories actually present show — no "Consumable 0 g" noise -->
      <div class="totals__chips">
        <span v-for="c in chips" :key="c.label" class="chip">
          <span class="t-label totals__clabel">
            <!-- 14 = the small icon tier, the size every other inline-with-text icon
                 uses. aria-hidden: the label beside it already says the word, so a
                 screen reader would otherwise hear the class twice. -->
            <HugeiconsIcon :icon="chipMark(c.label)" :size="14" :stroke-width="2" aria-hidden="true" />
            {{ c.label }}
          </span>
          <span class="t-num">{{ formatWeight(c.mg, list.displayUnit, { withUnit: false }) }} <span class="t-muted">{{ list.displayUnit }}</span></span>
        </span>
        <!-- the derived roll-up, set apart by a hairline because it doesn't belong to
             the partition on its left; the tooltip carries the definition so the label
             doesn't have to spell out the arithmetic -->
        <!-- opens DOWNWARD: the chips sit directly under the display-size total, and a
             top-anchored popup lands on top of the one number the page exists to show.
             Below it, it only crosses the category sparkline. Still flips back up near
             the viewport floor. -->
        <Tooltip
          v-if="showCarried"
          preferred-placement="bottom"
          text="Base + consumable — everything in the pack, nothing worn on your body."
        >
          <span class="chip chip--sum">
            <span class="t-label">Carried</span>
            <span class="t-num">{{ formatWeight(totals.carriedMg, list.displayUnit, { withUnit: false }) }} <span class="t-muted">{{ list.displayUnit }}</span></span>
          </span>
        </Tooltip>
        <!-- calories sit APART from the chips on their left: those three partition the
             weight, and this is a different quantity entirely — dropping it into the
             same row would read as a fourth slice of the total. Only appears once
             something carries a value (hasKcal), so the overwhelming majority of
             lists, which will never use it, never see it. -->
        <Tooltip
          v-if="totals.hasKcal"
          preferred-placement="bottom"
          text="Food energy across everything classed as consumable."
        >
          <span class="chip chip--alt">
            <span class="t-label">Calories</span>
            <span class="t-num">{{ kcalDisplay }} <span class="t-muted">kcal</span></span>
          </span>
        </Tooltip>
        <!-- Per day: the same calories divided by the trip's own dates. It sits with
             the calorie chip rather than behind its own rule — it IS that figure, at
             the scale that makes it mean something. Needs both halves (kcal and a date
             range), so it stays absent on the lists that have only one. -->
        <Tooltip v-if="plan" preferred-placement="bottom" :text="planTip">
          <span class="chip">
            <span class="t-label">Per day</span>
            <span class="t-num">{{ formatKcal(plan.kcalPerDay) }} <span class="t-muted">kcal</span></span>
          </span>
        </Tooltip>
      </div>
      <CategoryBar :list="list" />
    </div>
  </div>
</template>

<style scoped>
.totals {
  /* nothing on TOP: the big number sits directly above this in the editor, and the body's
     own gap is the whole distance between them. The extra 8px here made "base" and "worn"
     sit further from the figure than the elevation chart does in planning mode — the same
     number, two spacings. */
  padding-block: 0 var(--space-4);
}
/* An empty row still costs a row GAP, and this one is empty in the editor: the big figure
   moved out to GearEditor's shared Headline, so `props.headline` is false there and this
   wrapper renders with nothing in it. The 24px it was still charging is what put "Base"
   and "Worn" a row lower than planning's figures — the two views' small print sitting at
   different heights under the same number. It still holds the headline where one is
   passed, so this hides it only when there is genuinely nothing to show. */
.totals__main:empty {
  display: none;
}
.totals__main {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.totals__headline {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* OptionMenu supplies the trigger button (bare — this is a display figure that happens
   to be pressable, not a control that looks like one) and .menu supplies the
   positioning. The unit and chevron sit on the big figure's BASELINE, asked for with
   the `align` prop: a class here could not reach that button, since scoped styles stop
   at the component boundary. */
.totals__big {
  /* Never wider than the screen. The figure is one unbreakable token, so past about
     nine characters on a 320px phone it ran off the right edge — with the unit
     following it out of view and no horizontal scroll to reach either. `--acount-len`
     (AnimatedCount) gives the character count, ~0.58em is a tabular digit's advance,
     and 78vw leaves the unit its room; `min()` means a figure that already fits is
     untouched, so every ordinary total still renders at the full --text-display. */
  font-size: min(var(--text-display), calc(78vw / (0.58 * var(--acount-len, 6))));
  line-height: 0.95;
  letter-spacing: var(--track-tight);
  color: var(--accent);
}
/* unit + its dropdown chevron travel together, centered to each other, and the
   group baseline-aligns with the big figure */
.totals__uc {
  display: inline-flex;
  align-items: center;
  gap: var(--space-px);
}
.totals__unit {
  font-size: var(--text-title);
  font-weight: 400;
  color: var(--ink-2);
  /* half-step between the type system's two trackings: the full --track-tight
     visibly pinches a bare two-letter unit ("oz"), while normal tracking reads
     loose beside the tightly-tracked display figure */
  letter-spacing: -0.01em;
}
.totals__chev {
  flex: none;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.totals__amount:hover .totals__chev,
.totals__amount:focus-within .totals__chev {
  color: var(--ink);
}
/* the chevron turns over with the menu, like every other disclosure in the app */
.totals__chev.is-open {
  rotate: 180deg;
}
.totals__breakdown {
  /* one step up from --space-4 — the display-size figure above has a lot of optical
     mass, so the breakdown needs more clearance than a body-copy gap to stop reading
     as a caption hanging off the number */
  margin-top: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
/* …but only when the figure is actually IN here. In the editor it isn't — it moved out to
   the shared Headline — so this margin was clearance from something one level up that
   already keeps its own distance, and the two stacked put "Base" a row below where
   planning's figures sit under the identical number. */
.totals__main:empty + .totals__breakdown {
  margin-top: 0;
}

/* the glyph and its word are one object — baseline, with the mark stepping out of the
   group (align-self) so the WORD keeps setting the line and the icon centres optically
   on it. Same two-line idiom as .head__icon and the read view's trail mark; the label's
   own quiet ink carries the glyph, so it never out-weighs the figure under it. */
.totals__clabel {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
}
.totals__clabel > svg {
  flex: none;
  align-self: center;
}
.totals__chips {
  display: flex;
  flex-wrap: wrap;
  /* per axis, because only one of them is a gap between CHIPS. Across a line, --space-5
     is the trench the roll-up's rule sits in. Down the page it is the distance between
     two lines of the same little table, and each chip is already a two-line stack, so
     one flat --space-5 there set the wrapped line adrift as its own block. */
  gap: var(--space-3) var(--space-5);
  /* clips the hairlines below when they fall outside this box — which is exactly the
     case where a separated chip STARTS a wrapped line. A rule there separates the
     chip from the page edge rather than from anything, and the line break has already
     done the separating. (Safe to clip: the chips are text, and the tooltips they
     carry are teleported to <body>.) */
  overflow: hidden;
}
/* the stacked label-over-figure shape now lives in atoms/chip.scss — what stays here is
   only what's about THIS row: which chips are set apart, and how. */
/* the roll-up chip reads as a different KIND of figure from the slices beside it —
   a hairline + the row's own gap sets it apart without a heavy divider (same idiom
   as the ⋯ menu's report row). Calories take the same hairline for a related but
   distinct reason: --sum is a figure derived FROM the partition on its left, --alt
   isn't in that partition at all. Either way it must not read as a fourth slice.
   The trench the rule sits in — --space-5 either side, so it reads as centred rather
   than crowding the label — is built ENTIRELY out of space that a line break throws
   away: the row's own gap, plus a margin on the chip before it. A phone wraps this
   row, and space belonging to the separated chip (padding, or a start margin) came
   with it: "Carried" arrived at the head of the second line with a rule against the
   page edge and its label indented from the "Base" above it, dividing it from
   nothing. A gap exists only BETWEEN chips on a line, and a trailing margin at the
   end of a line is invisible, so both halves of the trench simply vanish at the wrap
   and the chip starts flush. */
.totals__chips > *:has(+ * > .chip--sum),
.totals__chips > *:has(+ * > .chip--alt) {
  margin-inline-end: var(--space-5);
}
/* the rule itself hangs OUTSIDE the chip, centred in that trench — a border on the
   chip's own edge would ride into the page margin at a line break. Out there it is
   past .totals__chips' content edge, which is what the clip above is for. */
.chip--sum,
.chip--alt {
  position: relative;
}
.chip--sum::before,
.chip--alt::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline-start: calc(-1 * var(--space-5));
  border-inline-start: 1px solid var(--line);
}
</style>
