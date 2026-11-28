import type { EffectScope } from "vue";
import { typeScale } from "~/utils/typeScale";
import { menuRoom, visibleBand } from "~/utils/viewportRoom";
import { useWindowEvent } from "./dom";

// WHERE A SUGGESTION MENU OPENS, and how tall it may be: the card under a list's add row
// (ItemInput) and the one under a kit's (VaultKitSection), both .ac__menu
// (atoms/controls.scss). Measured against the screen that is actually visible, which
// on a phone with the keyboard up is a strip above it.
//
// The list's own cap (10.5 rows, or 50dvh) can't see the keyboard: iOS doesn't shrink
// dvh for it, so a menu under a field in the lower half of the screen opened at full
// height behind the keyboard and showed nothing. GearEditor's onFocusIn lifts such a
// field toward the top on touch; this sizes the menu to the room that leaves (`room`,
// worn as --ac-room, the list's third cap) and flips it ABOVE the field only when below
// has less than a few rows even then, the page having no more scroll to give. The
// arithmetic is app/utils/viewportRoom's menuRoom, measured from the menu's anchor: the
// box its `top: 100%` hangs from. Not useMenuPlacement, which measures the window, and
// iOS keeps the window full height under the keyboard.

/** The menu's offset from its anchor: the --space-1 in `top: calc(100% + …)`. */
const MENU_GAP = 4;
/** Breathing room from the keyboard's top edge, or from the topbar when flipped. */
const MENU_EDGE = 8;
/** Below with less than this (three rows) flips above, if above has more. */
const MENU_MIN = 120;
/** Never shorter than about one row plus the scroller's padding. */
const MENU_FLOOR = 56;

/**
 * `anchor` is the box the menu hangs from, `shown` whether the menu is up. It is placed
 * as it opens and again whenever the room moves, for as long as it stays up.
 */
export function useSuggestPlacement(anchor: () => Element | null | undefined, shown: () => boolean) {
  const above = ref(false);
  const room = ref<number | null>(null);

  function place() {
    const el = anchor();
    if (!el) return;
    // px at the base type size, growing with it past 1920px like the rows they measure
    const scale = typeScale();
    const r = menuRoom(el.getBoundingClientRect(), visibleBand(), {
      gap: MENU_GAP * scale,
      edge: MENU_EDGE * scale,
      min: MENU_MIN * scale,
      floor: MENU_FLOOR * scale,
    });
    above.value = r.above;
    room.value = r.room;
  }

  let frame = 0;
  function schedule() {
    if (frame || !shown()) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (shown()) place();
    });
  }

  // The listeners exist only while the menu is up. A list mounts an add field per row,
  // and window listeners left on for each would all run on every tap and scroll, for a
  // menu only the focused row can have open.
  let scope: EffectScope | null = null;
  watch(shown, (up) => {
    if (!up) {
      scope?.stop();
      scope = null;
      return;
    }
    // placed BEFORE the menu renders (a pre-flush watcher), so it mounts on the right side
    // at the right height and the pop-in grows from the edge it actually hangs off
    place();
    if (scope) return;
    scope = effectScope(true);
    scope.run(() => {
      // The room under the field moves while you type: the keyboard finishes rising (the
      // visual viewport resizes), the editor lifts the field toward the top (GearEditor's
      // onFocusIn scrolls the page), a finger scrolls it, the window turns. Each
      // re-measures, once per frame at most.
      useWindowEvent("scroll", schedule, { passive: true });
      useWindowEvent("resize", schedule, { passive: true });
      const vv = window.visualViewport;
      vv?.addEventListener("resize", schedule);
      vv?.addEventListener("scroll", schedule);
      onScopeDispose(() => {
        vv?.removeEventListener("resize", schedule);
        vv?.removeEventListener("scroll", schedule);
        cancelAnimationFrame(frame);
        frame = 0;
      });
    });
  });
  onScopeDispose(() => scope?.stop());

  return { above, room };
}
