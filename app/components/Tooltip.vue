<script setup lang="ts">
// The simple hover tooltip, ported from the portfolio's <Tooltip> with its
// positioning logic intact: a fixed-position popup teleported to <body>, flipped
// top↔bottom by the viewport space actually available, and clamped horizontally to
// the page COLUMN's content edges rather than to the viewport — so a tooltip on a
// right-hand action icon lands inside the reading column instead of riding the
// window edge. Styles are in atoms/tooltip.scss; the header there says why.
//
// Wrap the trigger, don't replace it — the accessible NAME still belongs on the
// control itself (aria-label). This only adds the visible hover description, wired
// up with aria-describedby.
const { text, preferredPlacement = "top" } = defineProps<{
  text: string;
  preferredPlacement?: "top" | "bottom";
}>();

const triggerRef = useTemplateRef<HTMLElement>("triggerRef");
const tooltipRef = useTemplateRef<HTMLElement>("tooltipRef");
const isVisible = ref(false);
const placement = ref<"top" | "bottom">(preferredPlacement);
const tooltipId = useId();
// only the two computed values — `position: fixed` and `pointer-events: none` are
// constant, so they live in the stylesheet with the rest of the popup's looks
const tooltipStyle = ref({ left: "0px", top: "0px" });

const OFFSET = 8;
const EDGE_PADDING = 12;

// Tooltips are a hover affordance: a touch-only device fires an emulated
// mouseenter/focus on tap but no reliable mouseleave, leaving one stuck on screen.
// Queried once — the answer can't change for the life of the page.
const noHover = import.meta.client ? window.matchMedia("(hover: none)") : null;

// The horizontal content-edges (post-padding) of the closest `.wrap` ancestor of
// the trigger, so the tooltip clamps to the actual rendered page column rather than
// the viewport. If there's no `.wrap` ancestor (a tooltip floating outside the page
// column), fall back to a viewport clamp with a small buffer.
function getHorizontalBounds(): { min: number; max: number } {
  const win = { min: EDGE_PADDING, max: window.innerWidth - EDGE_PADDING };
  const t = triggerRef.value;
  const wrap = t?.closest<HTMLElement>(".wrap");
  if (!wrap) return win;
  const rect = wrap.getBoundingClientRect();
  const cs = getComputedStyle(wrap);
  return {
    min: rect.left + (parseFloat(cs.paddingInlineStart) || 0),
    max: rect.right - (parseFloat(cs.paddingInlineEnd) || 0),
  };
}

function positionTooltip() {
  if (!triggerRef.value || !tooltipRef.value) return;

  const trigger = triggerRef.value.getBoundingClientRect();
  // offsetWidth/Height, NOT getBoundingClientRect — this runs on the tick the popup
  // mounts, while the enter-from `scale(0.96) translateY(6px)` is still applied, and
  // a client rect reports the TRANSFORMED box. Measuring that made the popup read 4%
  // small, so a 280px tooltip clamped to 11px past the column's right edge. The
  // offset dimensions are the untransformed layout box, which is what we want.
  const { offsetWidth: width, offsetHeight: height } = tooltipRef.value;
  const bounds = getHorizontalBounds();

  // Flip to the other side only when the preferred one can't hold the popup.
  const needed = height + OFFSET + EDGE_PADDING;
  const room = preferredPlacement === "top" ? trigger.top : window.innerHeight - trigger.bottom;
  placement.value = room < needed
    ? (preferredPlacement === "top" ? "bottom" : "top")
    : preferredPlacement;

  // Centre on the trigger, then clamp to the page column's content-edges.
  const left = Math.min(trigger.left + trigger.width / 2 - width / 2, bounds.max - width);
  tooltipStyle.value = {
    left: `${Math.max(bounds.min, left)}px`,
    top: `${placement.value === "top" ? trigger.top - height - OFFSET : trigger.bottom + OFFSET}px`,
  };
}

async function show() {
  if (noHover?.matches) return;
  isVisible.value = true;
  await nextTick();
  positionTooltip();
}

function hide() {
  isVisible.value = false;
}

// A scroll with the pointer parked on the trigger slides the anchor out from under a
// `position: fixed` popup, and mouseout isn't reliably dispatched without pointer
// movement. Dismiss rather than re-position: the pointer has effectively left the
// thing being described. Capture, so a scroll inside any nested scroller counts too.
useWindowEvent("scroll", () => isVisible.value && hide(), { passive: true, capture: true });
</script>

<template>
  <div
    ref="triggerRef"
    class="tooltip-trigger"
    :aria-describedby="isVisible ? tooltipId : undefined"
    @mouseenter="show"
    @mouseleave="hide"
    @focus="show"
    @blur="hide"
  >
    <slot />

    <Teleport to="body" defer>
      <Transition name="tooltip">
        <div
          v-if="isVisible"
          :id="tooltipId"
          ref="tooltipRef"
          class="tooltip"
          :data-placement="placement"
          :style="tooltipStyle"
          role="tooltip"
        >
          <div class="tooltip__content">{{ text }}</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
