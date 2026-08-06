<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";

// Which of a list's views you're looking at.
//
// Lifted out of the editor's topbar, where it had been three icons with tooltips, for
// two reasons that turned out to be the same reason.
//
// It could not carry WORDS up there. The bar measures 338px of its 343px budget on a
// 375px phone, with two mobile concessions already spent to fit three icons — the gap
// halved, and the segments shaved below the 44px tap floor. Full labels need about 207px
// against the 116px the icons take. And icon-only means tooltip-only, which on touch
// means nothing at all: <Tooltip> declines to open where there is no hover, so on a phone
// the three marks had to be learned by pressing them.
//
// And the read views had nowhere to put it. Their bar is SiteTopbar, whose trailing slot
// is the ⋯ end-cap; there is no seat there for a switcher.
//
// In the page body, above the thing it switches, both problems stop existing: room for
// labels at any width, a seat on every surface, and the control sits next to its own
// consequence instead of in the chrome. What that costs is stickiness — it scrolls away,
// where the topbar version stayed reachable. Switching view is a top-of-page act, and
// 44px of permanent sticky height is expensive on a phone, so that is the right trade.
//
// NOT role="menubar", despite the name this goes by in conversation: that role is for
// application menus with submenus. Not role="tablist" either — see the group below.
export interface Mode {
  key: string;
  label: string;
  /** a Hugeicon; the label is what names the control, so this is decoration */
  icon: unknown;
}

const props = defineProps<{
  modes: readonly Mode[];
  current: string;
  /** names the group for a screen reader, e.g. "View mode" */
  label: string;
}>();

defineEmits<{ pick: [key: string] }>();

const index = computed(() => Math.max(0, props.modes.findIndex((m) => m.key === props.current)));
</script>

<template>
  <!--
    role="group" + aria-pressed, NOT a tablist, and the reason is structural rather than
    stylistic: in the editor two of these modes render the SAME subtree. Editing and
    packing differ by one prop that adds a checkbox column to the rows; only planning
    swaps the panel. A conforming tablist would need two tabs pointing `aria-controls` at
    one panel, which is a false statement in ARIA. The house agrees — the editor's own
    switcher was already role="group", and ItemRow writes down the rule this follows:
    aria-pressed is right exactly when the click toggles the state, which here it does.
  -->
  <div class="modebar" role="group" :aria-label="label" :style="{ '--seg-count': modes.length }">
    <!-- one tint slides between segments rather than a background per segment; damped
         --ease, because an indicator that overshoots leaves its own track -->
    <span class="modebar__pill" :style="{ '--seg-index': index }" aria-hidden="true" />
    <button
      v-for="m in modes"
      :key="m.key"
      type="button"
      class="modebar__opt"
      :class="{ 'is-active': m.key === current }"
      :aria-pressed="m.key === current"
      @click="$emit('pick', m.key)"
    >
      <HugeiconsIcon :icon="m.icon" :size="16" :stroke-width="2" aria-hidden="true" />
      <span class="modebar__label">{{ m.label }}</span>
    </button>
  </div>
</template>

<style scoped lang="scss">
// $bp-stack is injected globally (nuxt.config.ts `additionalData`) — no @use needed.
.modebar {
  position: relative;
  display: grid;
  // EQUAL segments, and this is load-bearing rather than tidy: the sliding pill's width
  // and travel are 1/N arithmetic over the container, so unequal labels would put the
  // tint under the wrong word. A grid of equal fractions is what makes that arithmetic
  // true, where the icon-only version got it for free from three identical squares.
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: var(--space-px);
  padding: var(--space-px);
  background: var(--paper-2);
  border-radius: var(--radius-pill);
  // full width on a phone — the words are the point, and a centred pill in a wide column
  // reads as a stray control rather than as this section's own header
  width: 100%;

  @media (min-width: $bp-stack) {
    // …but never a banner. Past the point where the labels fit comfortably it stops
    // growing and sits at the leading edge, where a reader's eye already is.
    width: auto;
    justify-self: start;
    grid-auto-columns: minmax(max-content, 1fr);
  }
}

.modebar__pill {
  position: absolute;
  top: var(--space-px);
  bottom: var(--space-px);
  left: var(--space-px);
  // One segment. The gaps are (N + 1) × --space-px — N − 1 between the segments plus the
  // padding either side — so the arithmetic is written once for however many there are.
  width: calc((100% - (var(--seg-count) + 1) * var(--space-px)) / var(--seg-count));
  border-radius: var(--radius-pill);
  background: color-mix(in oklab, var(--ink) 12%, transparent);
  pointer-events: none;
  // percentages resolve against the pill's OWN width — one segment — so each step is one
  // segment plus one gap
  transform: translateX(calc(var(--seg-index, 0) * (100% + var(--space-px))));
  transition: transform var(--dur) var(--ease);
  will-change: transform;
}

.modebar__opt {
  position: relative; // above the pill
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: var(--tap);
  padding-inline: var(--space-3);
  border-radius: var(--radius-pill);
  color: var(--ink-3);
  font: inherit;
  font-size: var(--text-chrome);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
  // Pin a standing compositing layer. These sit over the pill, so when its transform
  // animates Safari promotes them for the run and demotes them after — re-rasterising
  // each to the pixel grid, which jumps the label ~1px per switch. See
  // concepts/webkit-relayers-on-animation-boundaries.
  transform: translateZ(0);
}

.modebar__opt:hover {
  color: var(--ink-2);
}

.modebar__opt.is-active {
  color: var(--ink);
}

// The icon is decoration once there's a word beside it — it goes first at every width,
// and the word is what carries the meaning. On the narrowest phones the pair no longer
// fits three across, and the WORD is what stays: an unlabelled icon here is exactly the
// state this component was made to leave.
@media (max-width: 380px) {
  .modebar__opt svg {
    display: none;
  }
  .modebar__opt {
    padding-inline: var(--space-2);
  }
}
</style>
