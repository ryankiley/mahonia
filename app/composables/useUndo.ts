import { ref, type Ref } from "vue";

/** What the bar says happened, and how to take it back. */
export interface UndoOffer {
  /** what happened to `label`; "Removed" when left out, the common case */
  verb?: string;
  label: string;
  /** said after the label: " to Kitchen", " out of Cook kit" */
  tail?: string;
  restore: () => unknown;
}

/**
 * One undo at a time, for the list editor and My Gear alike — the timer behind
 * UndoBar. Each had its own (useGearList's, and a useToast holding an object on /gear),
 * and only the editor's held still while you pointed at it.
 *
 * 10s: the full notice → reach → tap loop has to fit, including on mobile. `hold`
 * pauses it while the bar is pointed at or holds focus (someone reading it, or reaching
 * for the button, shouldn't race the clock); `release` restarts the FULL window rather
 * than the remainder, which is cheap and never surprises.
 *
 * No lifecycle hooks, so the list's controller (not a component) can own one: a page
 * that does calls `clear` on unmount.
 */
export function useUndo<T extends UndoOffer = UndoOffer>() {
  const pending = ref(null) as Ref<T | null>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => (pending.value = null), 10_000);
  }
  function offer(u: T) {
    pending.value = u;
    arm();
  }
  function hold() {
    clearTimeout(timer);
  }
  function release() {
    if (pending.value) arm();
  }
  function clear() {
    clearTimeout(timer);
    pending.value = null;
  }
  /** Take it back. The bar goes FIRST, so a restore that offers an undo of its own keeps it. */
  function take() {
    const u = pending.value;
    if (!u) return;
    clear();
    return u.restore();
  }
  return { pending, offer, hold, release, clear, take };
}
