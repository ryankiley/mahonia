<script setup lang="ts">
// The simple hover tooltip, ported from the portfolio's <Tooltip> with its
// positioning logic intact: a fixed-position popup teleported to <body>, flipped
// top↔bottom by the viewport space actually available, and clamped horizontally to
// the page COLUMN's content edges rather than to the viewport — so a tooltip on a
// right-hand action icon lands inside the reading column instead of riding the
// window edge.
//
// What changed on the way over: the clamp ancestor is `.wrap` (the portfolio's
// `.grid`); the styles live in atoms/tooltip.scss rather than a scoped block, for
// the same reason they do there (a scoped block becomes a CSS chunk that every
// consumer pulls in synchronously); the image + keyboard-shortcut slots are dropped
// (nothing here shows a preview image or a shortcut — the `content` slot covers
// anything richer than a line of text); and a scroll dismissal is added, see below.
//
// Wrap the trigger, don't replace it — the accessible NAME still belongs on the
// control itself (aria-label). This only adds the visible hover description, wired
// up with aria-describedby.
const props = defineProps<{
  text?: string;
  offset?: number;
  preferredPlacement?: "top" | "bottom";
}>();

defineSlots<{
  default(): unknown;
  content(): unknown;
}>();

const triggerRef = useTemplateRef<HTMLElement>("triggerRef");
const tooltipRef = useTemplateRef<HTMLElement>("tooltipRef");
const isVisible = ref(false);
const placement = ref<"top" | "bottom">(props.preferredPlacement ?? "top");
const tooltipId = useId();

const tooltipStyle = ref<Record<string, string>>({
  position: "fixed",
  left: "0px",
  top: "0px",
  pointerEvents: "none",
});

const EDGE_PADDING = 12;

// The horizontal content-edges (post-padding) of the closest `.wrap` ancestor of
// the trigger, so the tooltip clamps to the actual rendered page column rather than
// the viewport. If there's no `.wrap` ancestor (a tooltip floating outside the page
// column), fall back to a viewport clamp with a small buffer.
function getHorizontalBounds(): { min: number; max: number } {
  const win = { min: EDGE_PADDING, max: window.innerWidth - EDGE_PADDING };
  const t = triggerRef.value;
  if (!t) return win;
  const wrap = t.closest<HTMLElement>(".wrap");
  if (!wrap) return win;
  const rect = wrap.getBoundingClientRect();
  const cs = getComputedStyle(wrap);
  const padL = parseFloat(cs.paddingInlineStart) || 0;
  const padR = parseFloat(cs.paddingInlineEnd) || 0;
  return { min: rect.left + padL, max: rect.right - padR };
}

function positionTooltip() {
  if (!triggerRef.value || !tooltipRef.value) return;

  const trigger = triggerRef.value.getBoundingClientRect();
  // offsetWidth/Height, NOT getBoundingClientRect — this runs on the tick the popup
  // mounts, while the enter-from `scale(0.96) translateY(6px)` is still applied, and
  // a client rect reports the TRANSFORMED box. Measuring that made the popup read 4%
  // small, so a 280px tooltip clamped to 11px past the column's right edge. The
  // offset dimensions are the untransformed layout box, which is what we want.
  const tooltip = { width: tooltipRef.value.offsetWidth, height: tooltipRef.value.offsetHeight };
  const preferred = props.preferredPlacement ?? "top";
  const offset = props.offset ?? 8;
  const bounds = getHorizontalBounds();

  // Flip to the other side only when the preferred one can't hold the popup.
  const spaceAbove = trigger.top;
  const spaceBelow = window.innerHeight - trigger.bottom;
  const needed = tooltip.height + offset + EDGE_PADDING;

  if (preferred === "top" && spaceAbove < needed) {
    placement.value = "bottom";
  } else if (preferred === "bottom" && spaceBelow < needed) {
    placement.value = "top";
  } else {
    placement.value = preferred;
  }

  const top =
    placement.value === "top"
      ? trigger.top - tooltip.height - offset
      : trigger.bottom + offset;

  // Centre on the trigger, then clamp to the page column's content-edges.
  let left = trigger.left + trigger.width / 2 - tooltip.width / 2;
  left = Math.max(bounds.min, Math.min(left, bounds.max - tooltip.width));

  tooltipStyle.value = {
    position: "fixed",
    left: `${left}px`,
    top: `${top}px`,
    pointerEvents: "none",
  };
}

// A scroll with the pointer parked on the trigger slides the anchor out from under
// a `position: fixed` popup, and mouseout isn't reliably dispatched without pointer
// movement. The portfolio could live with that; this app can't — its lists are long
// and the topbar is sticky, so wheel-while-hovering is routine. Dismiss rather than
// re-position: the pointer has effectively left the thing being described. The
// listener is bound only while a tooltip is up, so a page full of triggers isn't a
// page full of idle scroll handlers.
let detachScroll: (() => void) | undefined;
function watchScroll() {
  const onScroll = () => hide();
  // capture, so a scroll inside any nested scroller counts too
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  detachScroll = () => window.removeEventListener("scroll", onScroll, { capture: true });
}

async function show() {
  // Touch-only devices fire emulated mouseenter/focus on tap but no reliable
  // mouseleave/blur on scroll, leaving the tooltip stuck. Tooltips are a hover
  // affordance — skip them entirely here.
  if (window.matchMedia?.("(hover: none)").matches) return;
  isVisible.value = true;
  watchScroll();
  await nextTick();
  positionTooltip();
}

function hide() {
  isVisible.value = false;
  detachScroll?.();
  detachScroll = undefined;
}

onBeforeUnmount(hide);
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
          <div class="tooltip__content">
            <span v-if="text" class="tooltip__text">{{ text }}</span>
            <slot name="content" />
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<!-- Styles live in app/assets/styles/atoms/tooltip.scss (bundled into the entry
     CSS). Keeping them out of the SFC avoids a render-blocking CSS chunk on every
     page that uses <Tooltip>. -->
