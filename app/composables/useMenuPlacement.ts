import type { Ref } from "vue";

// Which SIDE a `.menu__list` popover should hang from — both axes — decided by where
// it actually fits rather than by the caller remembering.
//
// The atom anchors below its trigger and to the TRAILING edge (`top: 100%; right: 0`),
// which is correct for the menus it was written for — the ⋯, the account control,
// sharing — all of which sit at the end of a toolbar at the top of the page. Point it
// anywhere else and the default runs off the screen:
//
//  • HORIZONTALLY, at a trigger near the leading edge: the editor's total is 76px wide
//    with a 112px menu, so the menu opened at left −20.
//  • VERTICALLY, at a trigger near the viewport floor: the last row of a long list
//    opened its ⋯ menu 144px below the bottom of the screen — the one place a row's
//    actions are unreachable is the row you had to scroll to reach.
//
// Tooltip has flipped itself to fit since it was written; menus never learned to. This
// is the same idea, kept deliberately small: class toggles on the existing absolutely-
// positioned element, NOT a teleport to <body>. Menus measure their own rows for the
// travelling plate (see useMenuPlate, which reads offsetTop inside the list) and scroll
// with the page, and both of those would have to be rebuilt to make them fixed.
//
// Usage — measure once per open, since a menu can't resize while it's up:
//   const { atStart, above, place } = useMenuPlacement(listRef);
//   watch(open, (o) => o && nextTick(place));
//   <ul ref="listRef" :class="{ 'menu__list--start': atStart, 'menu__list--above': above }">
//
// HORIZONTALLY there are two answers to "it doesn't fit", and the caller picks:
//  • `flip` (the default) hangs the menu from the leading edge instead — right for
//    a menu whose trigger sits at one edge of a toolbar, where the other side is
//    all room.
//  • `shift` slides it right by exactly the overflow and leaves it hanging from the
//    trailing edge. For the row's classification popovers, whose trigger sits mid-
//    row on a phone: a 13rem card flipped to the leading edge of a trigger at
//    x≈180 on a 375px screen overruns the OTHER side, so the flip test fails and
//    the card would stay cut off at the left — while a slide of a few pixels fits.

/** Keep a menu this far from the window edge before calling it a collision. */
const EDGE_PADDING = 8;
/** The offset `.menu__list` sets between trigger and menu (`--space-1`). Stated rather
 *  than measured because the value has to be known BEFORE the flip class is applied,
 *  and by then the menu's own offsetTop is describing whichever side it is currently
 *  hanging from — the answer would depend on the previous open. Four pixels against an
 *  eight-pixel edge padding, so being a token behind here can only ever make the fit
 *  test a hair more conservative, never wrong in the direction that matters. */
const ANCHOR_GAP = 4;

export function useMenuPlacement(
  listRef: Ref<HTMLElement | null>,
  opts: { fit?: "flip" | "shift" } = {},
): {
  atStart: Ref<boolean>;
  above: Ref<boolean>;
  /** px to translate rightward — only ever non-zero under `fit: "shift"` */
  shift: Ref<number>;
  place: () => void;
} {
  const atStart = ref(false);
  const above = ref(false);
  const shift = ref(0);

  function place(): void {
    const list = listRef.value;
    const anchor = list?.offsetParent as HTMLElement | null;
    if (!list || !anchor) return;

    // Measure the anchor, and the list's own WIDTH and HEIGHT only — its current top
    // and left depend on whichever sides it is hanging from right now, so compute the
    // candidates rather than trusting where it happens to be sitting.
    //
    // offsetWidth/offsetHeight, NOT a client rect: this runs on the tick the menu
    // mounts, while the enter transform (translateY + scale(0.98)) is still applied,
    // and a rect reports the TRANSFORMED box. The offset pair is the untransformed
    // layout box. Same trap Tooltip.vue and useMenuPlate document; the ANCHOR isn't
    // animating, so its rect is sound.
    const a = anchor.getBoundingClientRect();
    const w = list.offsetWidth;
    const h = list.offsetHeight;

    const trailingLeft = a.right - w; // the default: right edges flush
    const leadingRight = a.left + w; // the flip: left edges flush

    if (opts.fit === "shift") {
      // slide by the exact overrun, measured off the rendered card rather than a
      // constant: its width is set in CSS (rem), so a hardcoded pixel twin is wrong
      // the moment the root font size isn't 16, and drifts if the rule is retuned
      shift.value = trailingLeft < EDGE_PADDING ? EDGE_PADDING - trailingLeft : 0;
    } else {
      // Prefer the default. Only flip when it would overrun the leading edge AND the
      // flip actually fits — a menu wider than the viewport is beyond helping, and
      // flipping it would just move which edge it's cut off at.
      atStart.value =
        trailingLeft < EDGE_PADDING && leadingRight <= window.innerWidth - EDGE_PADDING;
    }

    // Same rule downward, and the same preference: below unless below doesn't fit and
    // above does. A menu TALLER than the viewport fails both tests and stays below,
    // which is the right answer — flipping it would only change which end is cut off,
    // and below at least leaves its first row against the trigger you just pressed.
    const belowBottom = a.bottom + ANCHOR_GAP + h;
    const aboveTop = a.top - ANCHOR_GAP - h;
    above.value =
      belowBottom > window.innerHeight - EDGE_PADDING && aboveTop >= EDGE_PADDING;
  }

  return { atStart, above, shift, place };
}
