<script lang="ts">
// Tooltips began as a hover-only affordance: a touch device fires an emulated mouseenter
// on tap but no reliable mouseleave, so one raised that way stays stuck on screen. That
// guard is still right for HOVER — and it was wrong as a guard on the whole component,
// because it left the text reachable by mouse and by nothing else. So the component grew
// two more ways in: focus opened one, and a tap toggled one.
//
// TAP-TO-TOGGLE IS GONE. A tooltip is a hover affordance, and on a touch device it was
// second-guessing a tap that already did something — every one of these wraps a control
// that acts when you press it, so the tap fired the action AND raised a bubble
// describing it, over the very row you had just changed. On a phone that bubble is a
// meaningful slice of the screen, and the ones on the row controls sit exactly where the
// popover they open wants to be.
//
// What survives the change is the part that had a reason: a KEYBOARD focus still opens
// one, on any device. That was the accessibility argument for reaching past hover in the
// first place — the planning view's (?) buttons exist to explain where an estimate came
// from, for the people least likely to be holding a mouse — and it doesn't need touch to
// work. `:focus-visible` is what separates the two on a tablet, which reports `hover:
// none` whether or not a keyboard is attached to it (see showFromFocus).
//
// So: hover opens where hover exists, keyboard focus always opens, and touch opens
// nothing.
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

// WARM-UP — the next tooltip doesn't wait. The first tooltip waits
// HOVER_DELAY before it opens, so a pointer crossing the toolbar on its way somewhere
// else doesn't raise a trail of popups behind it. Once one has been up, the next one
// opened within WARM_MS of it going down is INSTANT — no wait and no animation
// (`data-instant`, atoms/tooltip.scss) — because a pointer moving along a row of
// controls is reading them, and making it wait at each is the toolbar feeling slow.
//
// Module scope, like the hover probe above: "a tooltip was just up" is a fact about the
// page, not about one instance, and the next tooltip is by definition a different
// instance from the last. `open` counts the ones on screen right now, so one raised
// while another is still up (focus on one control, the pointer on its neighbour) is
// instant too. Date.now(), not performance.now(), so a test's fake clock drives it.
const HOVER_DELAY = 400;
const WARM_MS = 300;
const warm = { open: 0, closedAt: -Infinity };
const isWarm = () => warm.open > 0 || Date.now() - warm.closedAt < WARM_MS;
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
/** raised without the wait or the animation — see WARM-UP at the top of the file */
const instant = ref(false);
const placement = ref<"top" | "bottom">(preferredPlacement);
const tooltipId = useId();
// only the computed values — `position: fixed` and `pointer-events: none` are constant,
// so they live in the stylesheet with the rest of the popup's looks. The origin's x is
// one of them: the popup scales out of its trigger, and only this file knows where the
// trigger sits inside the clamped popup (atoms/tooltip.scss).
const tooltipStyle = ref<Record<string, string>>({ left: "0px", top: "0px" });

const OFFSET = 8;
const EDGE_PADDING = 12;

// Whether hover exists is a device fact, so it lives at module scope above rather than
// being re-queried by every instance — see isHoverless().

// The horizontal content-edges (post-padding) of the closest `.wrap` ancestor of
// the trigger, so the tooltip clamps to the actual rendered page column rather than
// the viewport. If there's no `.wrap` ancestor (a tooltip floating outside the page
// column), fall back to a viewport clamp with a small buffer.
function getHorizontalBounds(): { min: number; max: number } {
  // clientWidth, not innerWidth: the popup is position: fixed, so its edge is the layout
  // viewport's, and innerWidth also counts a classic scrollbar's column (Windows,
  // Linux) — 15px the popup would be clamped into and then clipped out of.
  const win = { min: EDGE_PADDING, max: document.documentElement.clientWidth - EDGE_PADDING };
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
  // mounts, while the enter-from scale is still applied, and a client rect reports the
  // TRANSFORMED box. Measuring that made the popup read small (4%, when it started from
  // 0.96), so a 280px tooltip clamped to 11px past the column's right edge. The offset
  // dimensions are the untransformed layout box, which is what we want.
  const { offsetWidth: width, offsetHeight: height } = tooltipRef.value;
  const bounds = getHorizontalBounds();

  // Flip to the other side only when the preferred one can't hold the popup.
  const needed = height + OFFSET + EDGE_PADDING;
  const room = preferredPlacement === "top" ? trigger.top : window.innerHeight - trigger.bottom;
  placement.value = room < needed
    ? (preferredPlacement === "top" ? "bottom" : "top")
    : preferredPlacement;

  // Centre on the trigger's INK, then clamp to the page column's content-edges.
  //
  // Usually the ink is the box and the shift is 0. It isn't when a control aligns its
  // glyph to one side of a larger tap target — which the editor's row actions do on
  // purpose, right-aligning every glyph so the drag grip sits flush at the row's edge
  // (see ItemRow's .item__actions). Centred on the BOX, a tooltip there points at the
  // padding beside the picture it describes: measured at 8px left of a 16px glyph in a
  // 32px button, which reads as a misaligned popup rather than as a deliberate box.
  //
  // Opt-in via a custom property, because only the caller knows its own alignment, and
  // it INHERITS — so one declaration on a cluster reaches every trigger inside it,
  // including the ones a child component renders, with no :deep() per control.
  const shift = parseFloat(getComputedStyle(triggerRef.value).getPropertyValue("--tip-shift")) || 0;
  const ink = trigger.left + trigger.width / 2 + shift;
  const left = Math.max(bounds.min, Math.min(ink - width / 2, bounds.max - width));
  tooltipStyle.value = {
    left: `${left}px`,
    top: `${placement.value === "top" ? trigger.top - height - OFFSET : trigger.bottom + OFFSET}px`,
    // where the trigger's ink falls inside the popup, kept on the popup's own edge if a
    // clamp has pushed it past
    "--tooltip-origin-x": `${Math.max(0, Math.min(width, ink - left))}px`,
  };
}

// Whether this tooltip has ever been raised. The Teleport below mounts only once
// it has: a <Teleport> costs an anchor node in <body> even while its content is
// v-if'd away, and the editor mounts three to six of these per row, so a hidden
// 150-row list was holding hundreds of empty anchors for popups nobody had asked
// for. Latched, never reset — once the Teleport exists it stays, so the leave
// transition of a tooltip going back down still has a place to play.
const everShown = ref(false);

// The hover's wait, while it runs. One per instance: a trigger has one pointer over it.
let pending: ReturnType<typeof setTimeout> | undefined;
function cancelPending() {
  clearTimeout(pending);
  pending = undefined;
}

// Every change of visibility goes through here, so the page-wide warm-up count can't
// drift from what's on screen.
function setVisible(on: boolean) {
  if (on === isVisible.value) return;
  isVisible.value = on;
  if (on) warm.open++;
  else {
    warm.open--;
    warm.closedAt = Date.now();
  }
}

/** Raise it now. `now` skips the animation as well (keyboard focus); otherwise it is
 *  skipped only while the page is warm (see WARM-UP). */
async function open(now = false) {
  cancelPending();
  if (disabled || isVisible.value) return;
  instant.value = now || isWarm();
  everShown.value = true;
  setVisible(true);
  listen();
  await nextTick();
  positionTooltip();
}

/**
 * Hover — refuses on a touch device, where there is no reliable way back down. Waits
 * HOVER_DELAY first, unless a tooltip was up a moment ago, in which case it opens at
 * once and without its fade (WARM-UP, top of file).
 */
function show() {
  if (disabled || isHoverless() || isVisible.value || pending) return;
  if (isWarm()) {
    void open();
    return;
  }
  listen(); // a scroll during the wait cancels it, as one after would dismiss it
  pending = setTimeout(() => {
    pending = undefined;
    void open();
  }, HOVER_DELAY);
}

/**
 * Did this focus come from the keyboard? `:focus-visible` is the browser's own answer to
 * exactly that — a button focused by tap or click doesn't match it, a tabbed-to one does
 * — so there's no heuristic here to keep in step with the platforms.
 *
 * Engines without it throw on the selector rather than reporting false, and the safe
 * side of that guess is the quiet one: on a touch device a false raises nothing, which
 * is the whole point there, and where a pointer hovers it only sends the focus the
 * hover's way, so the tooltip still comes up, after the wait.
 */
function isKeyboardFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Focus — a KEYBOARD focus opens one on any device, at once and without animating: no
 * hover to wait out, and Tab is an action repeated in bursts, and those never
 * animate. On a touch device that is the only way focus opens one. The test is
 * needed because TAPPING a button focuses it: without it, everything the retired
 * tap-to-toggle path used to show would simply come back in through focusin, and
 * removing the click handler would have changed nothing. It also keeps the case the
 * hover guard alone would cost — a tablet with a keyboard reports `hover: none`, and its
 * user still has to be able to read this.
 *
 * A focus that ISN'T the keyboard's, where a pointer can hover — a click focusing the
 * button it landed on (Chromium does; Safari doesn't) — goes the hover's way, wait and
 * all. The pointer is on the trigger already, so that is usually a no-op; what it stops
 * is a click popping the description up instantly, ahead of the hover's own wait.
 *
 * `focusin`, not `focus`, in the template: only the former bubbles from the trigger.
 */
function showFromFocus(e: FocusEvent) {
  if (isKeyboardFocus(e.target)) void open(true);
  else show();
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
  cancelPending();
  setVisible(false);
  unlisten();
}

// A scroll with the pointer parked on the trigger slides the anchor out from under a
// `position: fixed` popup, and mouseout isn't reliably dispatched without pointer
// movement. Dismiss rather than re-position: the pointer has effectively left the
// thing being described. Capture, so a scroll inside any nested scroller counts too.
// The same goes for a hover still WAITING to open: it would open on a trigger the
// scroll has moved out from under the pointer.
//
// Bound only while a tooltip is open or about to be. At most one ever is, but every
// <Tooltip> in the tree is an instance — the editor's toolbar alone has five — and a
// capture-phase scroll listener fires for every scroller on the page, including the
// vault pane's hundred-row list. Registering per-instance meant paying that whole set
// on every scroll frame to do nothing. (Adding it twice is harmless: the same listener
// with the same capture flag is only ever registered once.)
function listen() {
  window.addEventListener("scroll", hide, { passive: true, capture: true });
}
function unlisten() {
  window.removeEventListener("scroll", hide, { capture: true });
}
// Unmounted while up — a row deleted under the pointer — still counts as going down,
// so the page-wide count doesn't hold the next tooltip instant forever.
onScopeDispose(() => {
  cancelPending();
  setVisible(false);
  unlisten();
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
    @keydown.escape="hide"
  >
    <slot />

    <!-- mounted on first show only — see everShown -->
    <Teleport v-if="everShown" to="body" defer>
      <Transition name="tooltip">
        <div
          v-if="isVisible"
          :id="tooltipId"
          ref="tooltipRef"
          class="tooltip"
          :data-placement="placement"
          :data-instant="instant || undefined"
          :style="tooltipStyle"
          role="tooltip"
        >
          <div class="tooltip__content">{{ text }}</div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
