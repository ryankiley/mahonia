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

const emit = defineEmits<{ pick: [key: string] }>();

const opts = useTemplateRef<HTMLButtonElement[]>("opts");

/**
 * Arrows move the selection, the way a radio group does — and the way the design system's
 * segmented control does, whose comment is the reason the tabindex above is roving:
 * "A radiogroup is one tab stop and the arrows move inside it — that's the whole reason
 * the arrows exist. With every option tabbable, Tab walked the three views instead of the
 * page, and the arrows were a second way to do what Tab already did."
 *
 * Selection follows focus, which is correct here because switching view is free and
 * instant; the pattern only needs decoupling when activating a choice is expensive.
 */
function onKey(e: KeyboardEvent) {
  if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
  const i = props.modes.findIndex((m) => m.key === props.current);
  if (i < 0) return;
  e.preventDefault();
  const step = /Left|Up/.test(e.key) ? -1 : 1;
  // wraps at both ends, so the arrows never dead-end on the first or last view
  const at = (i + step + props.modes.length) % props.modes.length;
  emit("pick", props.modes[at]!.key);
  // focus follows the selection, or the next arrow press starts from the old option
  nextTick(() => opts.value?.[at]?.focus());
}
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

<style scoped lang="scss">
// PORTED FROM THE DESIGN SYSTEM's menubar (.ds-menubar / .ds-menubar__item), not
// re-derived. Its rules, verbatim, with only the token names mapped onto this app's:
//
//   --foreground-primary   → --ink
//   --foreground-secondary → --ink-3
//   --wash-hover    5%     → the same 5%
//   --wash-selected 8%     → the same 8%
//   --control-1     24px   → the same 24px
//   --radius-2             → --radius-2 (both are the 8px step)
//   --t-caption-*          → --text-chrome, the app's one chrome size
//   --duration-fast/--ease-out → --dur / --ease
//
// `corner-shape: superellipse()` is dropped: it is a Chrome-only property that the
// design system opts into and this app has never used anywhere.
//
// FLAT BY DEFAULT, because this is chrome — a menubar lives at the top edge as part of
// the frame, not as a card floating over the document. WRAPS, because "as many items as
// needed" is the requirement and nowrap would push the last of them out of reach.
.modebar {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-px);
  padding: var(--space-1);
  border-radius: var(--radius-3);
  background: transparent;
  box-shadow: none;
  color: var(--ink);
  // the row's own padding would otherwise indent it past the title beneath it
  margin-left: calc((var(--space-1) + var(--space-2)) * -1);
}

.modebar__opt {
  appearance: none;
  border: 0;
  background: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  // 30px, NOT the design system's 24px --control-1 — the one metric of the port that is
  // deliberately off. Its menubar is words only; this one puts a 16px icon beside the
  // word, and 24px leaves 4px of air above and below a mark that needs to sit in its own
  // space rather than press against the plate's edges. The extra six give the icon room
  // without making the bar read as buttons.
  height: 30px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-2);
  font-family: inherit;
  font-size: var(--text-chrome);
  color: var(--ink-3);
  white-space: nowrap;
  transition:
    background-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

// The wash matters: without a plate, a pointer crossing the bar changes the word's colour
// and leaves no target under it. --wash-hover (5%) sits under the selected state's 8%, so
// pointing and choosing stay two steps rather than one.
.modebar__opt:hover {
  background: color-mix(in oklab, var(--ink) 5%, transparent);
  color: var(--ink);
}

.modebar__opt:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}

// SELECTED IS A STATE, not a hover that happens to be stuck — it keeps its wash whether
// the pointer is on it or not, because the bar has to say which view you are in.
.modebar__opt.is-active {
  background: color-mix(in oklab, var(--ink) 8%, transparent);
  color: var(--ink);
}

// The icons are this app's addition, not the design system's — its menubar is words only.
// They go first at every width and vanish before the word does.
@media (max-width: 380px) {
  .modebar__opt svg {
    display: none;
  }
}
</style>
