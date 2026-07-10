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
  // true when the pointer is fully clear of the editing surface (over the sticky
  // top bar, the footer, or off-screen). A release while outside cancels instead of
  // committing — the touch-reachable abort, since there's no Escape key on mobile.
  let outside = false;

  function onMove(ev: PointerEvent) {
    if (!dragId.value) return;
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    // a gap *between* folders still counts as in-list (persist + commit); only a
    // release clear of the whole editor body reads as a cancel.
    outside = !el?.closest(".editor__body");
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

  function onUp() {
    const id = dragId.value;
    const target = hooks.target();
    const cancelled = outside;
    reset();
    if (!cancelled && id && target) hooks.commit(id, target);
  }

  // touch/OS can end a gesture with pointercancel (second finger, edge-swipe,
  // scroll steal) instead of pointerup — drop the drag, commit nothing.
  function onCancel() {
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
