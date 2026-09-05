<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";

// The page's one big number, and the same ELEMENT in every view.
//
// It used to be two: the weight lived inside TotalsBar and the distance inside
// TrailPlanPanel, so switching to planning unmounted one headline and mounted another.
// Two figures of the same size in the same place, and the only way to tell they were
// different elements was that the number jumped and the count re-ran on every switch.
// Lifting it here makes the swap what it looks like — the figure stays put and the value
// changes under it, which is also what lets AnimatedCount tween BETWEEN modes instead of
// restarting from zero each time.
//
// Deliberately dumb: it holds no opinion about what the number means. The composing view
// decides which figure the page is about, and this only knows how to show one and let you
// change its unit — which is why the same gesture works in all three.
const props = defineProps<{
  /** the number, already formatted and WITHOUT its unit */
  value: string;
  /** the unit as shown beside it, e.g. "lb" or "mi" */
  unit: string;
  options: readonly { key: string; label: string }[];
  /** names the picker for a screen reader, e.g. "Weight unit" */
  label: string;
  title?: string;
  /** an explicit accessible name for the trigger, where the figure alone reads oddly */
  triggerLabel?: string;
  /**
   * What the figure is OF, shown only when that stops being the obvious thing.
   * The headline normally needs no label ("the big figure makes it implicit" —
   * TotalsBar), and that argument holds exactly as long as the number means the
   * whole list; narrowed to one person's pack, the same reasoning demands the
   * name. Absent = the label-less headline this has always been.
   */
  caption?: string;
}>();

defineEmits<{ pick: [key: string] }>();
</script>

<template>
  <div class="headline">
    <!-- The whole figure is the trigger: tapping the number to change its unit is the
         affordance, and it is the same one in every view — so changing mode changes what
         the number IS, never what you can do to it. -->
    <OptionMenu
      class="headline__amount"
      align="baseline"
      :options="props.options"
      :current="props.unit"
      :label="props.label"
      :title="props.title"
      :trigger-label="props.triggerLabel"
      @pick="(u) => $emit('pick', u)"
    >
      <template #trigger="{ open }">
        <AnimatedCount class="t-num headline__big" :value="props.value" />
        <span class="headline__uc" aria-hidden="true">
          <span class="headline__unit">{{ props.unit }}</span>
          <!-- stroke 2.25, not the app-wide 2: at size 16 it renders an exact 1.5px
               stroke (a crisp 3 device px at 2x), so the chevron holds its weight beside
               a display-size figure instead of thinning out against it. -->
          <HugeiconsIcon
            :icon="ChevronDownIcon"
            class="chev"
            :class="{ 'is-open': open }"
            :size="16"
            :stroke-width="2.25"
          />
        </span>
      </template>
    </OptionMenu>
    <span v-if="props.caption" class="headline__caption t-clip">{{ props.caption }}</span>
  </div>
</template>

<style scoped lang="scss">
.headline {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.headline__amount {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
}

.headline__big {
  /* Never wider than the screen. The figure is one unbreakable token, so past about
     nine characters on a 320px phone it ran off the right edge — with the unit
     following it out of view and no horizontal scroll to reach either. `--acount-len`
     (AnimatedCount) gives the character count, ~0.58em is a tabular digit's advance,
     and 78vw leaves the unit its room; `min()` means a figure that already fits is
     untouched, so every ordinary total still renders at the full --text-display. */
  font-size: min(var(--text-display), calc(78vw / (0.58 * var(--acount-len, 6))));
  line-height: 0.95;
  letter-spacing: var(--track-tight);
}

/* unit + chevron travel together as one object, so the mark stays tight to the word it
   belongs to rather than drifting off toward the figure */
.headline__uc {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

/* The unit takes the SAME type as the total's own (TotalsBar's .totals__unit):
   --text-title, not --text-chrome. At 14px beside a 64px figure the "g" read as a
   footnote stuck to the number rather than as the other half of it — and it was the
   same unit, in the same construction, at two different sizes depending on which
   component happened to draw the figure. Weight 400 keeps it from competing with the
   figure now that it is big enough to be seen. */
.headline__unit {
  font-size: var(--text-title);
  font-weight: 400;
  /* half-step between the type system's two trackings: the full --track-tight
     visibly pinches a bare two-letter unit ("oz"), while normal tracking reads
     loose beside the tightly-tracked display figure */
  letter-spacing: -0.01em;
  color: var(--ink-2);
  transition: color var(--dur) var(--ease);
}

/* Unit and chevron lift TOGETHER, under the pointer and on keyboard focus. They are
   already one object in the layout (.headline__uc) and one target in the markup, so
   lighting only the mark made the word beside it look like it belonged to something
   else. They start a step apart — the chevron is the quieter of the two — and meet at
   --ink, which is the lift the total's own chevron takes (TotalsBar) and the vault's
   (gear.vue). Hung off the trigger, not the whole .headline, so the caption beside it
   isn't a hover target for a menu it has nothing to do with. */
.headline__amount:hover .headline__unit,
.headline__amount:hover .chev,
.headline__amount:focus-within .headline__unit,
.headline__amount:focus-within .chev {
  color: var(--ink);
}

/* The caption sits on the figure's baseline, one step past the unit, and holds
   --text-chrome — small print qualifying the number. It used to take "the unit's own
   type", which said the same thing back when the unit was 14px too; now that the unit
   matches the total's --text-title, following it would set a person's name at 22px
   beside the figure, which is the second heading this deliberately isn't (the same
   reason it isn't t-label, bigger and bolder still). So the size is stated here rather
   than inherited by coincidence. Truncates rather than wraps (.t-clip): a name runs to
   60 chars, and the figure is the headline — same guard the ListHead names wear. */
.headline__caption {
  font-size: var(--text-chrome);
  color: var(--ink-3);
  max-width: min(40vw, 26ch);
}
</style>
