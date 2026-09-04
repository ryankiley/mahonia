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
            class="headline__chev"
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

.headline__unit {
  font-size: var(--text-chrome);
  color: var(--ink-3);
}

.headline__chev {
  color: var(--ink-3);
  transition: rotate var(--dur) var(--ease);
}

.headline__chev.is-open {
  rotate: 180deg;
}

/* The caption sits on the figure's baseline, one step past the unit — in the
   UNIT's own type, so the two read as one run of chrome qualifying the number
   (t-label rendered bigger and bolder than the unit beside it: a heading, not a
   qualifier). Truncates rather than wraps (.t-clip): a name runs to 60 chars, and
   the figure is the headline — same guard the ListHead names wear. */
.headline__caption {
  font-size: var(--text-chrome);
  color: var(--ink-3);
  max-width: min(40vw, 26ch);
}
</style>
