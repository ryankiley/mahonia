<script lang="ts">
// Tooltips began as a hover-only affordance: a touch device fires an emulated mouseenter
// on tap but no reliable mouseleave, so one raised that way stays stuck on screen. That
// guard is still right for HOVER — and it was wrong as a guard on the whole component.
//
// It meant the text was reachable by mouse and by nothing else. Focus never opened one
// either (see the template: `focus` does not bubble, so a listener on the wrapper never
// heard the button inside it), which left every tooltip in the app mouse-only. Harmless
// on a toolbar icon that repeats a visible label; not harmless on the planning view's (?)
// buttons, whose entire job is to explain where an estimate came from and which exist
// precisely for the people least likely to be holding a mouse.
//
// So: hover still refuses to open on a touch device, focus always opens, and a tap
// toggles.
//
// MODULE scope, not per instance. The query is a property of the DEVICE, so one
// MediaQueryList answers for the whole page — and the editor mounts a tooltip on nearly
// every row control, so a 150-item list was calling matchMedia ~900 times to learn the
// same fact. Resolved lazily on first use so importing the component never touches
// `window` (it renders on the server too). `.matches` is still read live at each call,
// so a device that gains a pointer mid-session is picked up exactly as before.
//
// Keyed on `window.matchMedia` itself, because what's memoised is a HANDLE to that API:
// if the function is ever replaced the old MediaQueryList is stale and has to be
// re-derived. Costs one reference compare per call, and keeps the probe honest under a
// stubbed matchMedia (see tests/tooltip.nuxt.test.ts, which swaps it mid-suite).
let hoverlessMq: MediaQueryList | null = null;
let hoverlessFrom: unknown;
function isHoverless(): boolean {
  if (!import.meta.client) return false;
  if (hoverlessFrom !== window.matchMedia) {
    hoverlessFrom = window.matchMedia;
    hoverlessMq = window.matchMedia("(hover: none)");
  }
  return hoverlessMq?.matches ?? false;
}
</script>

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
const { text, preferredPlacement = "top", disabled = false } = defineProps<{
  text: string;
  preferredPlacement?: "top" | "bottom";
  /**
   * Suppress the tooltip while its trigger has already said the same thing another
   * way — a toggle that has opened its own popover, say. Two floating surfaces off
   * one control read as a glitch, and the hover description is the redundant one:
   * the popover states the setting in full. The accessible name is unaffected; it
   * lives on the control, not here.
   */
  disabled?: boolean;
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

// Whether hover exists is a device fact, so it lives at module scope above rather than
// being re-queried by every instance — see isHoverless().

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

async function open() {
  if (disabled) return;
  isVisible.value = true;
  await nextTick();
  positionTooltip();
}

/** Hover — refuses on a touch device, where there is no reliable way back down. */
function show() {
  if (isHoverless()) return;
  void open();
}

/**
 * Focus — always opens, including on a touch device, because a keyboard attached to a
 * tablet reports `hover: none` and its user still has to be able to read this.
 * `focusin`, not `focus`, in the template: only the former bubbles from the trigger.
 */
function showFromFocus() {
  void open();
}

/**
 * Tap — a toggle, which is the only shape that works without a mouseleave. Bound
 * unconditionally but inert wherever hover exists, so a click on a trigger that is
 * already showing its tooltip on hover doesn't blink it off.
 */
function toggle() {
  if (!isHoverless()) return;
  if (isVisible.value) hide();
  else void open();
}

// Tap-to-open needs a tap-to-close that isn't the trigger. Bound only while one is open,
// like the scroll dismissal below and for the same reason.
function dismissOutside(e: Event) {
  if (!triggerRef.value?.contains(e.target as Node)) hide();
}

// dismiss one already on screen when the trigger opens its own surface — the hover
// that raised it is still live, so nothing else would take it down
watch(
  () => disabled,
  (off) => {
    if (off) hide();
  },
);

function hide() {
  isVisible.value = false;
}

// A scroll with the pointer parked on the trigger slides the anchor out from under a
// `position: fixed` popup, and mouseout isn't reliably dispatched without pointer
// movement. Dismiss rather than re-position: the pointer has effectively left the
// thing being described. Capture, so a scroll inside any nested scroller counts too.
//
// Bound only WHILE a tooltip is open. At most one ever is, but every <Tooltip> in the
// tree is an instance — the editor's toolbar alone has five — and a capture-phase
// scroll listener fires for every scroller on the page, including the vault pane's
// hundred-row list. Registering per-instance meant paying that whole set on every
// scroll frame to do nothing.
watch(isVisible, (visible) => {
  if (visible) {
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    document.addEventListener("pointerdown", dismissOutside, true);
  } else {
    window.removeEventListener("scroll", hide, { capture: true });
    document.removeEventListener("pointerdown", dismissOutside, true);
  }
});
onScopeDispose(() => {
  window.removeEventListener("scroll", hide, { capture: true });
  document.removeEventListener("pointerdown", dismissOutside, true);
});
</script>

<template>
  <div
    ref="triggerRef"
    class="tooltip-trigger"
    :aria-describedby="isVisible ? tooltipId : undefined"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="showFromFocus"
    @focusout="hide"
    @click="toggle"
    @keydown.escape="hide"
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
