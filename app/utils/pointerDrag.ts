// Shared pointer-drag scaffolding for the two drag-to-reorder gestures (item
// rows + folders). Owns the LIFECYCLE — listener attach/detach, explicit pointer
// capture, the text-selection lock, Escape/pointercancel aborts, and the
// outside-the-editor release-to-cancel — while each caller keeps only its own
// drop-target math and commit. One copy, so the gesture plumbing can't drift
// between the two.

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
    const body = document.querySelector(".editor__body");
    if (body) {
      const b = body.getBoundingClientRect();
      outside = ev.clientY < b.top || ev.clientY > b.bottom;
    } else {
      outside = !el?.closest(".editor__body");
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
