import type { Ref } from "vue";

// Which edge a `.menu__list` popover should hang from, decided by where it actually
// fits rather than by the caller remembering.
//
// The atom anchors to the TRAILING edge (`right: 0`), which is correct for the menus
// it was written for — the ⋯, the account control, sharing — all of which sit at the
// end of a toolbar. Point it at a trigger near the leading edge of the page and a menu
// wider than its trigger runs straight off the screen: the editor's total is 76px wide
// with a 112px menu, so the menu opened at left −20.
//
// Tooltip has flipped itself to fit since it was written; menus never learned to. This
// is the horizontal half of the same idea, kept deliberately small: a class toggle on
// the existing absolutely-positioned element, NOT a teleport to <body>. Menus measure
// their own rows for the travelling plate (see useMenuPlate, which reads offsetTop
// inside the list) and scroll with the page, and both of those would have to be
// rebuilt to make them fixed.
//
// Usage — measure once per open, since a menu can't resize while it's up:
//   const { atStart, place } = useMenuPlacement();
//   watch(open, (o) => o && nextTick(place));
//   <ul ref="listRef" :class="{ 'menu__list--start': atStart }">

/** Keep a menu this far from the window edge before calling it a collision. */
const EDGE_PADDING = 8;

export function useMenuPlacement(listRef: Ref<HTMLElement | null>): {
  atStart: Ref<boolean>;
  place: () => void;
} {
  const atStart = ref(false);

  function place(): void {
    const list = listRef.value;
    const anchor = list?.offsetParent as HTMLElement | null;
    if (!list || !anchor) return;

    // Measure the anchor, and the list's WIDTH only — its current left depends on
    // whichever edge it's hanging from right now, so compute both candidates rather
    // than trusting where it happens to be sitting.
    const a = anchor.getBoundingClientRect();
    const w = list.offsetWidth;

    const trailingLeft = a.right - w; // the default: right edges flush
    const leadingRight = a.left + w; // the flip: left edges flush

    // Prefer the default. Only flip when it would overrun the leading edge AND the
    // flip actually fits — a menu wider than the viewport is beyond helping, and
    // flipping it would just move which edge it's cut off at.
    atStart.value =
      trailingLeft < EDGE_PADDING && leadingRight <= window.innerWidth - EDGE_PADDING;
  }

  return { atStart, place };
}
