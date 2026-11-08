// WHICH HAND IS ON THE APP: `data-input="keyboard"` on <html> while the last thing the
// person did was press a key, gone again the moment the pointer moves or presses.
//
// It exists for one rule: what the keyboard sets off doesn't animate. A shortcut, an
// arrow key, Enter's new row, Tab landing on a field — the keyboard is how the fast,
// repeated work gets done, and motion on it reads as the interface lagging behind the
// hands. atoms/modality.scss reads the flag and makes every CSS transition and
// animation instant while it is set; motionIsInstant() below is the same answer for
// the script that starts a Web Animation or waits out a duration itself (a Web
// Animation is not a CSS animation, and the stylesheet can't reach it).
//
// CAPTURE on window, so the flag is already set when the key's own handler runs: a
// mode switched by an arrow key renders with the durations already at zero.
// A bare modifier is not keyboard USE — it is half of a chord, often a pointer one
// (shift-click, ⌘-click), and the pointer half is what the person is doing.
// pointermove as well as pointerdown, so reaching for the mouse is enough to bring
// motion back before the click it is reaching to make.

const BARE_MODIFIERS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/** The last input came from the keyboard. */
export function keyboardModality(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.input === "keyboard";
}

/**
 * Motion is off right now: the keyboard flag is set, or the person asked the system
 * for reduced motion. For script that starts its own animation or sizes a wait from a
 * motion token: run nothing, wait for nothing. (The CSS side of the same answer is
 * atoms/modality.scss and the reduced-motion kill-switch in main.scss.)
 */
export function motionIsInstant(): boolean {
  if (typeof window === "undefined") return true;
  return keyboardModality() || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export default defineNuxtPlugin(() => {
  const root = document.documentElement;
  const onKey = (e: KeyboardEvent) => {
    if (BARE_MODIFIERS.has(e.key)) return;
    if (root.dataset.input !== "keyboard") root.dataset.input = "keyboard";
  };
  const onPointer = () => {
    if (!root.dataset.input) return;
    delete root.dataset.input;
    // Under the flag every CSS animation ran at zero length and finished on the spot.
    // Taking the flag off hands each one still applied its real duration back, and a
    // CSS animation re-timed in place carries on from wherever that puts it: a row
    // Enter added a moment ago (its arrival class lingers, FolderRows) would replay the
    // tail of its slide the instant the mouse moved. So whatever is running now is
    // finished at its new length — nothing the pointer itself starts has started yet,
    // since this runs in the capture phase ahead of every handler. getAnimations()
    // flushes the style change first; an endless animation can't be finished, and is
    // left to run.
    if (typeof CSSAnimation === "undefined") return;
    for (const a of document.getAnimations?.() ?? []) {
      if (!(a instanceof CSSAnimation) || a.playState === "finished") continue;
      try {
        a.finish();
      } catch {
        /* an infinite iteration count has no end to finish at */
      }
    }
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("keydown", onKey, opts);
  window.addEventListener("pointerdown", onPointer, opts);
  window.addEventListener("pointermove", onPointer, opts);
});
