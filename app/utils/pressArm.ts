// Its own file, apart from pointerDrag.ts, for the bundle: the editor's row and folder
// drags put that module on the first load, and this half has one caller, the My Gear
// pane, which loads when it is opened.
//
// A press that BECOMES a drag. Both vault surfaces let you grab a row anywhere —
// the row is the whole target, so there's no grip to hang the gesture on — which
// means every press needs the same scaffold to decide what it was: a record of
// where it started, window-level move/up/cancel listeners, and a travel
// threshold before the drag is armed and handed off. This owns that arming;
// what the drag then IS (createPointerDrag on /vault, the editor's insert
// gesture in the pane) stays with the caller, in onDrag.

interface PressArmOptions<T> {
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
  /** Touch, with a hold configured: the hold has elapsed, so the next move past the
   *  threshold is a drag. Called from a timer AT that moment rather than on the next
   *  move, because this is where the caller says the hold registered (a lifted row, a
   *  tick of vibration) and that has to reach a finger that is still holding still.
   *  A press-and-hold you can't feel take is a gesture you can't trust. */
  onArm?: (payload: T) => void;
  /** A press that ARMED ended without becoming a drag — lifted, cancelled, replaced
   *  by another press, or torn down — so the caller can take its feedback back down.
   *  Not called for a press that never armed, nor once onDrag has the gesture: what a
   *  live drag looks like, and when it ends, is the caller's. */
  onDisarm?: (payload: T) => void;
}

export function createPressArm<T>(opts: PressArmOptions<T>) {
  // One object for the gesture in flight. `armedAt` is the timestamp the drag
  // becomes available from — 0 for a mouse (immediately), now + the hold for a
  // finger — which is the whole hold rule as a comparison at move time. The one
  // timer (holdTimer) exists only to ANNOUNCE the arming (onArm), since nothing
  // else happens at that instant to hang it on; the rule itself never waits on it.
  let press: { x: number; y: number; pointerId: number; armedAt: number; armed: boolean; payload: T } | null =
    null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  /** Drop the press record and its listeners; hand back what it was. */
  function teardown() {
    const p = press;
    press = null;
    clearTimeout(holdTimer);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    return p;
  }

  /** The press ended without a drag: lifted, cancelled, replaced, or unmounted. */
  function end() {
    const p = teardown();
    if (p?.armed) opts.onDisarm?.(p.payload);
  }

  function onMove(ev: PointerEvent) {
    if (!press || ev.pointerId !== press.pointerId) return;
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < opts.threshold) return;
    // moved before the hold elapsed → this is a scroll, not a drag; stand down
    if (ev.timeStamp < press.armedAt) return end();
    const payload = teardown()!.payload;
    opts.onDrag(payload, ev);
  }

  /** The caller's pointerdown handler. A non-primary button, or a press on an
   *  excluded control, never arms. */
  function start(payload: T, ev: PointerEvent) {
    if (ev.button !== 0) return;
    if (opts.exclude && (ev.target as HTMLElement).closest(opts.exclude)) return;
    end();
    const hold = opts.touchHoldMs && ev.pointerType === "touch" ? opts.touchHoldMs : 0;
    press = {
      x: ev.clientX,
      y: ev.clientY,
      pointerId: ev.pointerId,
      armedAt: hold ? ev.timeStamp + hold : 0,
      armed: false,
      payload,
    };
    if (hold) {
      holdTimer = setTimeout(() => {
        if (!press) return;
        press.armed = true;
        opts.onArm?.(press.payload);
      }, hold);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  /** Whether a press is in flight that a move at `timeStamp` would turn into a drag —
   *  its hold (if any) has elapsed. The question a scroll guard asks: once this is
   *  true, a finger moving over the list is carrying a row, not scrolling it, and the
   *  browser must not be handed the move (a touch scroll steals the pointer outright,
   *  pointercancel and all). Takes the asking event's own timestamp rather than
   *  trusting the timer, which can land a frame after a move that already qualifies. */
  function armed(timeStamp: number): boolean {
    return !!press && (press.armed || timeStamp >= press.armedAt);
  }

  // `end` doubles as the unmount teardown — the press must not outlive its rows
  return { start, end, armed };
}
