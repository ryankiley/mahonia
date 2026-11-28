<script setup lang="ts">
import { counted } from "~~/shared/tidyText";
import type { ListSnapshot, Totals, Unit } from "~~/shared/types";
import { carriedIsDistinct, formatKcal, formatWeight, totalsChips } from "~~/shared/weights";
import { KCAL_PER_DAY_GENEROUS, KCAL_PER_DAY_LIGHT, foodHeadcount, foodPlan } from "~~/shared/foodPlan";
import type { PersonSelection } from "~~/shared/people";

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
    /**
     * The person chip the reader picked, null for everyone. `list` and `totals` arrive
     * already narrowed to it, but food per day also needs to know whether they're the
     * whole trip's (split across everyone on it) or one person's: foodHeadcount says
     * which. Required, so a new caller can't forget it and divide one person's food by
     * the whole group.
     */
    personFilter: PersonSelection;
  }>(),
  { headline: true },
);

const emit = defineEmits<{
  "set-unit": [Unit];
}>();

// The big figure, formatted once for the headline and for its trigger's accessible
// name: the name carries the weight, because a label on a button replaces its contents
// and "Weight unit" alone would leave the page's largest number unspoken.
const totalDisplay = computed(() => formatWeight(props.totals.totalMg, props.list.displayUnit, { withUnit: false }));

// the classification breakdown chips — which show (and when a lone "Base" is
// noise) is a judgment about the data, shared with the social-card image via
// totalsChips so the two renderings can't drift
const chips = computed(() => totalsChips(props.totals));
// The row's order — Base · Consumable · Carried | Worn | Calories · Per day — is the
// sum it draws: what's in the pack, what in it gets eaten, what the pack weighs; then
// what's on your body; then food. The big total above is Carried + Worn. It used to be
// the partition in one run with Carried after a rule, which read as the sum of all
// three, Worn included, and didn't add up (Ryan, 2026-09-05). totalsChips keeps the
// partition order for the exports and the OG card, which print no Carried.
const packChips = computed(() => chips.value.filter((c) => c.label !== "Worn"));
const wornChip = computed(() => chips.value.find((c) => c.label === "Worn"));

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
const plan = computed(() => {
  const eaters = foodHeadcount(props.list.people, props.personFilter);
  return eaters == null ? null : foodPlan(props.totals, props.list, eaters);
});
const planTip = computed(() => {
  const p = plan.value;
  if (!p) return "";
  const across = `${kcalDisplay.value} kcal across ${counted(p.days, "day")}`;
  // A group's figure is an average: say so, and say it's one person's, so the band
  // after it reads as one person's too.
  const span =
    p.people > 1
      ? `${across}, shared evenly by the ${p.people} people on this list: ${formatKcal(p.kcalPerDay)} kcal a person a day.`
      : `${across}.`;
  // Named as a rule of thumb, and phrased as a range rather than a target — the band
  // is a sanity check on the arithmetic, not a recommendation for a body.
  //
  // Deliberately no colour on the chip for a "light" reading. The band is a rule of
  // thumb, not a verdict on a body — a flat five-mile day on 1,800 kcal is somebody
  // having a nice time, and painting that red would be the app inventing a certainty
  // it doesn't have. The number beside the range is the whole signal.
  const band =
    p.reading === "typical"
      ? `That’s inside the ${formatKcal(KCAL_PER_DAY_LIGHT)}–${formatKcal(KCAL_PER_DAY_GENEROUS)} kcal a day people commonly plan for walking with a pack.`
      : `People commonly plan ${formatKcal(KCAL_PER_DAY_LIGHT)}–${formatKcal(KCAL_PER_DAY_GENEROUS)} kcal a day for walking with a pack.`;
  return p.perDayDistance ? `${span} ${p.perDayDistance} a day. ${band}` : `${span} ${band}`;
});
</script>

<template>
  <div class="totals">
    <!-- no "Total" label: the big figure makes it implicit. the figure starts
         zeroed (not a placeholder line) so nothing reflows when the first
         weighted item lands — the number just counts up. -->
    <!-- The figure, its unit and the picker behind them are Headline: the one the
         editor draws above all three of its views, so the two can't drift. It stands
         directly in .totals, with no row of its own: the breakdown below reads whether
         it is the FIRST thing in here (its :first-child rule) to know whether a figure
         sits above it. -->
    <Headline
      v-if="props.headline"
      :value="totalDisplay"
      :unit="list.displayUnit"
      :options="WEIGHT_UNIT_OPTIONS"
      label="Weight unit"
      :trigger-label="`${totalDisplay} ${list.displayUnit}, change unit`"
      @pick="(u) => emit('set-unit', u as Unit)"
    />

    <!-- always rendered: the bar holds a blank rail at zero so it never reflows in.
         the chips stay per-category — they pop in as each class first gains weight -->
    <div class="totals__breakdown">
    <!-- one inner box: the breakdown folds as ONE grid track on a mode switch (below),
         and a track can only slide a single item -->
    <div class="totals__breakdowninner">
      <!-- only the categories actually present show — no "Consumable 0 g" noise -->
      <div class="totals__chips">
        <FigureChip
          v-for="c in packChips"
          :key="c.label"
          :label="c.label"
          :value="formatWeight(c.mg, list.displayUnit, { withUnit: false })"
          :unit="list.displayUnit"
        />
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
          text="Base + consumable: everything in the pack, nothing worn on your body."
        >
          <FigureChip label="Carried" :value="formatWeight(totals.carriedMg, list.displayUnit, { withUnit: false })" :unit="list.displayUnit" />
        </Tooltip>
        <!-- Worn closes the weights, apart from the run before it: the one weight that
             isn't in the pack, so it can't read as a slice of Carried. -->
        <FigureChip
          v-if="wornChip"
          class="chip--apart"
          :label="wornChip.label"
          :value="formatWeight(wornChip.mg, list.displayUnit, { withUnit: false })"
          :unit="list.displayUnit"
        />
        <!-- calories sit APART from the chips on their left: those three partition the
             weight, and this is a different quantity entirely — dropping it into the
             same row would read as a fourth slice of the total. Only appears once
             something carries a value (hasKcal), so the overwhelming majority of
             lists, which will never use it, never see it. -->
        <!-- Calories and Per day wrap as ONE. A "Per day" alone at the head of a line is a
             rate cut off from the figure it's a rate of (Ryan, 2026-09-05); as a pair
             they either fit the line or leave it together. -->
        <span class="totals__food">
          <Tooltip
            v-if="totals.hasKcal"
            preferred-placement="bottom"
            text="Calories in everything marked Consumable."
          >
            <FigureChip class="chip--alt" label="Calories" :value="kcalDisplay" unit="kcal" />
          </Tooltip>
          <!-- Per day: the same calories divided by the trip's own dates. It sits with
               the calorie chip rather than behind its own rule — it IS that figure, at
               the scale that makes it mean something. Needs both halves (kcal and a date
               range), so it stays absent on the lists that have only one. -->
          <Tooltip v-if="plan" preferred-placement="bottom" :text="planTip">
            <FigureChip label="Per day" :value="formatKcal(plan.kcalPerDay)" :unit="plan.people > 1 ? 'kcal a person' : 'kcal'" />
          </Tooltip>
          </span>
      </div>
      <CategoryBar :list="list" />
    </div>
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
.totals__breakdown {
  /* one step up from --space-4 — the display-size figure above has a lot of optical
     mass, so the breakdown needs more clearance than a body-copy gap to stop reading
     as a caption hanging off the number */
  margin-top: var(--space-5);
  display: grid;
  grid-template-rows: 1fr;
}
.totals__breakdowninner {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
/* The breakdown opens and closes as ONE piece. This box is shorter than its content for
   as long as its track is moving (the mode switch's fold, atoms/modeswitch.scss), and a
   flex column hands that shortfall to whichever child may shrink — the figures' row,
   which clips (.totals__chips) and so has no minimum. It was squeezed from nothing back
   to its height while the breakdown faded in: the numbers under Base / Consumable /
   Carried uncovered a line at a time, and the bar and the folder legend slid down 11px
   beneath them, a second movement inside the first (Ryan, 2026-11-25: they "reveal
   separately with their own motion vs as a unit"). Nothing in here shrinks: every part
   stands where it will rest from the first frame, and the track's edge is the only clip. */
.totals__breakdowninner > * {
  flex-shrink: 0;
}
/* …but only when the figure is actually IN here. In the editor it isn't — it moved out to
   the shared Headline — so this margin was clearance from something one level up that
   already keeps its own distance, and the two stacked put "Base" a row below where
   planning's figures sit under the identical number. With no figure the breakdown is
   the first element in .totals, which is the test. */
.totals__breakdown:first-child {
  margin-top: 0;
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
   with it: the set-apart chip arrived at the head of the second line with a rule
   against the page edge and its label indented from the "Base" above it, dividing
   it from nothing. (--apart is Worn now, the one weight not in the pack, closing the
   Base · Consumable · Carried run; the rule used to sit on Carried.) A gap exists only BETWEEN chips on a line, and a trailing margin at the
   end of a line is invisible, so both halves of the trench simply vanish at the wrap
   and the chip starts flush. */
.totals__chips > *:has(+ .chip--apart),
.totals__chips > *:has(+ .totals__food) {
  margin-inline-end: var(--space-5);
}
/* the rule itself hangs OUTSIDE the chip, centred in that trench — a border on the
   chip's own edge would ride into the page margin at a line break. Out there it is
   past .totals__chips' content edge, which is what the clip above is for. */
.totals__food {
  display: flex;
  gap: inherit;
  flex: none;
}
.chip--apart,
.chip--alt {
  position: relative;
}
.chip--apart::before,
.chip--alt::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline-start: calc(-1 * var(--space-5));
  border-inline-start: 1px solid var(--border-primary);
}

/* The breakdown stands down in packing: that mode's header is the list's name, the
   tabs and the total, and on a phone the Base/Worn/Consumable line and the category
   bar held the first checkbox at the bottom edge of the screen (measured: 763px of
   844). Its fold on the mode switch is keyed on the editor body's data-mode with
   everything else the mode changes, in atoms/modeswitch.scss. */
</style>
