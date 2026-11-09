<script setup lang="ts">
import { HugeiconsIcon, type IconNode } from "~/utils/hugeicon";

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
interface Mode {
  key: string;
  label: string;
  /** the label is what names the control, so this is decoration */
  icon: IconNode;
}

const props = defineProps<{
  modes: readonly Mode[];
  current: string;
  /** names the group for a screen reader, e.g. "View mode" */
  label: string;
}>();

const emit = defineEmits<{ pick: [key: string] }>();

// Arrows move the selection, the way a radio group does — the roving tab stop, and
// why it roves, are useRovingRadio's (shared with the people chips).
const { onKey } = useRovingRadio(
  () => props.modes.length,
  () => props.modes.findIndex((m) => m.key === props.current),
  (at) => emit("pick", props.modes[at]!.key),
);
</script>

<template>
  <!--
    A RADIOGROUP, matching the design system's segmented control (.ds-seg) rather than
    inventing a pattern for the same job. Its rule: "Tabs navigate; this selects. So it is
    a radiogroup, and the value is one you would submit." That is exactly this — the modes
    are one value with three settings, not three destinations.
    Not a tablist for the same reason, and for a structural one besides: in the editor two
    of these modes render the SAME subtree (editing and packing differ by one prop that
    adds a checkbox column), so two tabs would have to point aria-controls at one panel.
  -->
  <div
    class="modebar"
    role="radiogroup"
    :aria-label="label"
    @keydown="onKey"
  >
    <button
      v-for="m in modes"
      :key="m.key"
      type="button"
      ref="opts"
      class="modebar__opt"
      :class="{ 'is-active': m.key === current }"
      role="radio"
      :aria-checked="m.key === current"
      :tabindex="m.key === current ? 0 : -1"
      @click="$emit('pick', m.key)"
    >
      <HugeiconsIcon :icon="m.icon" :size="16" :stroke-width="2" aria-hidden="true" />
      <span class="modebar__label">{{ m.label }}</span>
    </button>
  </div>
</template>

<!-- its styles are atoms/modebar.scss: shared by two routes, they belong with the other atoms -->
