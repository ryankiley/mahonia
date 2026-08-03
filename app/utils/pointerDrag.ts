// Shared pointer-drag scaffolding for the site's drag-to-reorder gestures (the
// editor's item rows + folders, the vault pane, /vault). createPointerDrag owns
// a drag's LIFECYCLE — listener attach/detach, explicit pointer capture, the
// text-selection lock, Escape/pointercancel aborts, and the outside-the-surface
// release-to-cancel — while each caller keeps only its own drop-target math and
// commit. createPressArm below owns the step BEFORE that: deciding whether a
// press on a row is a drag at all. One copy of each, so the gesture plumbing
// can't drift between surfaces.

export interface PointerDragHooks<T> {
  /** Update the caller's drop target from the pointer. `el` is the current
   *  elementFromPoint hit; `dragId` the id passed to start(). */
  track: (ev: PointerEvent, el: HTMLElement | null, dragId: string) => void;
  /** The caller's current drop target — read at release, just before reset. */
  target: () => T | null;
  /** Apply the drop. Called only for a release inside the editing surface. */
  commit: (dragId: string, target: T) => void;
  /** Per-gesture extra state on pickup (e.g. the item drag's start Y). */
  onStart?: (ev: PointerEvent) => void;
  /** Per-gesture extra cleanup on reset (e.g. the item drag's dy). */
  onReset?: () => void;
  /** CSS selector for the surface the gesture belongs to — a release outside its
   *  vertical band cancels instead of committing (the touch-reachable abort, since
   *  there's no Escape key on a phone). Defaults to the editor's body.
   *
   *  It has to be a parameter rather than a constant: this scaffold started as the
   *  editor's alone, and a second surface (/vault's folders) inherited a hardcoded
   *  `.editor__body` that isn't on its page — so `outside` computed true on every
   *  move and EVERY drag silently cancelled at the drop. */
  within?: string;
}

export function createPointerDrag<T>(hooks: PointerDragHooks<T>) {
  const dragId = ref<string | null>(null);
  // The pointer id we explicitly captured (see start()), so we can release it on
  // reset. -1 = nothing captured.
  let capturedId = -1;
  // The pointer that started the drag. The window listeners below hear EVERY
  // pointer — on touch, a second finger tapping off a grip would otherwise fire
  // pointerup (committing the drag wherever the indicator sits) or pointercancel
  // (aborting it) while finger 1 is still holding the row. Separate from
  // capturedId, which resets to -1 when setPointerCapture is unsupported.
  let activePointer = -1;
  // true when the pointer is fully clear of the editing surface (over the sticky
  // top bar, the footer, or off-screen). A release while outside cancels instead of
  // committing — the touch-reachable abort, since there's no Escape key on mobile.
  let outside = false;

  function onMove(ev: PointerEvent) {
    if (!dragId.value || ev.pointerId !== activePointer) return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    // Cancel only on a VERTICAL escape — dragging up over the sticky top bar or down
    // past the footer. A sideways drag into the horizontal page margin is still a
    // valid drop: nesting a row means dragging it rightward off the row's right edge
    // (where the grip sits) into the gutter, so the margin must NOT read as "outside".
    const within = hooks.within ?? ".editor__body";
    const surface = document.querySelector(within);
    if (surface) {
      const b = surface.getBoundingClientRect();
      outside = ev.clientY < b.top || ev.clientY > b.bottom;
    } else {
      // the surface isn't on this page at all — nothing to escape from, so a
      // release always commits rather than always cancelling
      outside = false;
    }
    hooks.track(ev, el, dragId.value);
  }

  function detach() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey);
  }

  // Escape aborts the drag without committing — the clean cancel now that a release
  // always commits to the last target.
  function onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") reset();
  }

  // Clear all drag state + listeners without committing. Safe to call any time
  // (re-entrant drag start, interrupted gesture, list dispose).
  function reset() {
    detach();
    if (typeof document !== "undefined") {
      document.body.style.userSelect = "";
      if (capturedId !== -1) {
        try {
          document.documentElement.releasePointerCapture(capturedId);
        } catch {
          /* pointer already gone */
        }
      }
    }
    capturedId = -1;
    dragId.value = null;
    hooks.onReset?.();
  }

  function onUp(ev: PointerEvent) {
    if (ev.pointerId !== activePointer) return;
    const id = dragId.value;
    const target = hooks.target();
    const cancelled = outside;
    reset();
    if (!cancelled && id && target) hooks.commit(id, target);
  }

  // touch/OS can end a gesture with pointercancel (edge-swipe, scroll steal)
  // instead of pointerup — drop the drag, commit nothing. Only for the drag's
  // own pointer: a system gesture that kills the drag cancels the active
  // pointer itself, so it passes the guard; a second finger's cancel doesn't.
  function onCancel(ev: PointerEvent) {
    if (ev.pointerId !== activePointer) return;
    reset();
  }

  function start(id: string, ev: PointerEvent) {
    if (dragId.value) reset(); // never stack a second gesture's listeners
    ev.preventDefault();
    // Capture the pointer to the document root — a node that never becomes
    // pointer-events:none. On touch, pointerdown grants implicit capture to the
    // grip, but the lifted row immediately goes pointer-events:none (so drop
    // detection can see the rows underneath), which drops that implicit capture
    // and fires pointercancel — killing the drag before it starts. Explicit
    // capture on a stable node keeps the gesture alive; pointermove/up still
    // bubble to the window listeners below.
    activePointer = ev.pointerId;
    capturedId = ev.pointerId;
    try {
      document.documentElement.setPointerCapture(ev.pointerId);
    } catch {
      capturedId = -1; // non-pointer / unsupported — fall back to plain listeners
    }
    dragId.value = id;
    outside = false;
    hooks.onStart?.(ev);
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  }

  return { dragId, start, reset };
}

// ---------------------------------------------------------------------------
// A press that BECOMES a drag. Both vault surfaces let you grab a row anywhere —
// the row is the whole target, so there's no grip to hang the gesture on — which
// means every press needs the same scaffold to decide what it was: a record of
// where it started, window-level move/up/cancel listeners, and a travel
// threshold before the drag is armed and handed off. This owns that arming;
// what the drag then IS (createPointerDrag above on /vault, the editor's insert
// gesture in the pane) stays with the caller, in onDrag.

export interface PressArmOptions<T> {
  /** px of pointer travel that separates a drag from a stray press */
  threshold: number;
  /** Touch only: how long a finger must hold before movement means "drag". A
   *  finger that moves straight away is almost always scrolling the list, so
   *  distance alone would hijack every swipe — a short hold arms the drag, and a
   *  swipe that starts before it elapses is left to the browser as a scroll.
   *  Omit where distance alone is the right reading for every pointer. */
  touchHoldMs?: number;
  /** CSS selector — a press starting inside a match is left alone, because that
   *  element owns its own press (a select, a button). */
  exclude?: string;
  /** The press travelled far enough: start the actual drag. Called with the
   *  arming move event, after the press record and listeners are already torn
   *  down — so a re-entrant press inside the handler starts clean. */
  onDrag: (payload: T, ev: PointerEvent) => void;
}

export function createPressArm<T>(opts: PressArmOptions<T>) {
  // One object for the gesture in flight. `armedAt` is the timestamp the drag
  // becomes available from — 0 for a mouse (immediately), now + the hold for a
  // finger — which is the whole hold rule as a comparison at move time, with no
  // timer to run or clear.
  let press: { x: number; y: number; pointerId: number; armedAt: number; payload: T } | null = null;

  function end() {
    press = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  }

  function onMove(ev: PointerEvent) {
    if (!press || ev.pointerId !== press.pointerId) return;
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < opts.threshold) return;
    // moved before the hold elapsed → this is a scroll, not a drag; stand down
    if (ev.timeStamp < press.armedAt) return end();
    const payload = press.payload;
    end();
    opts.onDrag(payload, ev);
  }

  /** The caller's pointerdown handler. A non-primary button, or a press on an
   *  excluded control, never arms. */
  function start(payload: T, ev: PointerEvent) {
    if (ev.button !== 0) return;
    if (opts.exclude && (ev.target as HTMLElement).closest(opts.exclude)) return;
    end();
    press = {
      x: ev.clientX,
      y: ev.clientY,
      pointerId: ev.pointerId,
      armedAt: opts.touchHoldMs && ev.pointerType === "touch" ? ev.timeStamp + opts.touchHoldMs : 0,
      payload,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  // `end` doubles as the unmount teardown — the press must not outlive its rows
  return { start, end };
}
