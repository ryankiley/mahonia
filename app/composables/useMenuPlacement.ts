import type { Ref } from "vue";
import { typeScale } from "~/utils/typeScale";

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
// positioned element, NOT a teleport to <body>. Menus scroll with the page, and that
// would have to be rebuilt to make them fixed.
//
// A menu built on <MenuList> doesn't call this: the card places itself as it mounts, and
// its props are these options. Call it for a popover that is its own element (sharing,
// the row's class card, the list header's panels, the icon picker). Measure on open; the
// composable measures again itself if the window resizes while the menu is up:
//   const { atStart, above, place } = useMenuPlacement(listRef);
//   watch(open, (o) => o && nextTick(place));
//   <ul ref="listRef" :class="{ 'menu__list--start': atStart, 'menu__list--above': above }">
//
// It assumes the atom's anchoring: flush to an edge of the offsetParent, --space-1 below
// it. A card its own CSS nudges off that (the editor's ⋯ and sharing, and the offline
// account card on a phone, each a few px in from the end of the bar) is judged as if it
// sat flush, which at the trailing end of a toolbar never changes the answer.
//
// HORIZONTALLY there are two answers to "it doesn't fit", and the caller picks:
//  • `flip` (the default) hangs the menu from the leading edge instead — right for
//    a menu whose trigger sits at one edge of a toolbar, where the other side is
//    all room. With `side: "start"` the leading edge is the usual one and the
//    trailing edge the flip.
//  • `center` sets the menu UNDER THE MIDDLE of its trigger, and slides it only as far
//    as it must to stay on screen. For a menu that hangs off a small icon in the middle
//    of something (a row's marks): flush to one of the icon's edges, the card reads as
//    belonging to whatever is beside the icon, and it covers that neighbour. Centred, it
//    points at the thing that opened it (Ryan, 2026-11-27: "shouldn't menu fire from
//    center when it can?"). At a trigger hard against an edge the slide brings the card
//    in to the edge padding, which is where the other two modes put it too.
//  • `shift` slides it right by exactly the overflow and leaves it hanging from the
//    trailing edge. For the row's classification popovers, whose trigger sits mid-
//    row on a phone: a 13rem card flipped to the leading edge of a trigger at
//    x≈180 on a 375px screen overruns the OTHER side, so the flip test fails and
//    the card would stay cut off at the left — while a slide of a few pixels fits.

// VERTICALLY a menu can also live inside a card that clips it — the My Gear sheet on a
// phone is a 440px card with `overflow: hidden`, and its "Add to" folder picker sits
// in the middle of it. Measured against the window, eight folders fit above the
// trigger, so the menu flipped up and the card cut off its top five. `fit: "within"`
// measures against the nearest ancestor that clips vertically instead (intersected
// with the window), and when neither side fits there it takes the roomier side and
// caps the card to that room (`maxHeight`), so the list scrolls inside the card rather
// than past its edge. Opt-in, because a capped menu needs the caller to apply the
// height; a folder body's own clip is already lifted by the time `place` runs (it
// lifts for as long as the menu's element is inside it: atoms/folder.scss).

/** Keep a menu this far from the window edge before calling it a collision. */
const EDGE_PADDING = 8;
/** A capped menu never shrinks below this: about two and a half rows, enough to read
 *  as a list you can scroll rather than a sliver. */
const MIN_CAPPED_HEIGHT = 96;

/** The vertical span a menu inside `el` can paint into: the nearest ancestor that
 *  clips on the y axis, cut to the window. The window alone when nothing clips. */
function verticalBounds(el: HTMLElement, pad: number): { top: number; bottom: number } {
  let top = pad;
  let bottom = window.innerHeight - pad;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "visible") continue;
    const r = node.getBoundingClientRect();
    top = Math.max(top, r.top + pad);
    bottom = Math.min(bottom, r.bottom - pad);
    break;
  }
  return { top, bottom };
}
/** The offset `.menu__list` sets between trigger and menu (`--space-1`). Stated rather
 *  than measured because the value has to be known BEFORE the flip class is applied,
 *  and by then the menu's own offsetTop is describing whichever side it is currently
 *  hanging from — the answer would depend on the previous open. Four pixels against an
 *  eight-pixel edge padding, so being a token behind here can only ever make the fit
 *  test a hair more conservative, never wrong in the direction that matters. */
const ANCHOR_GAP = 4;

export function useMenuPlacement(
  listRef: Readonly<Ref<HTMLElement | null>>,
  opts: {
    fit?: "flip" | "shift" | "center";
    within?: boolean;
    /** under `flip`: the edge the card hangs from when both fit. "end" is the atom's
     *  default; "start" is for a card whose trigger opens the bar or the row (the lists
     *  switcher, the trip dates), which flips to the trailing edge only when it would
     *  run off the right */
    side?: "end" | "start";
  } = {},
): {
  atStart: Ref<boolean>;
  /** under `fit: "center"`: the menu is set on the trigger's middle (always, unless it
   *  is wider than the window, when the default stands) */
  centered: Ref<boolean>;
  above: Ref<boolean>;
  /** px to translate rightward: non-zero only under `fit: "shift"`, and under
   *  `fit: "center"` (where it may be negative) when the centred card would leave the
   *  window */
  shift: Ref<number>;
  /** px the card may be tall, or null for its own height — only ever set under
   *  `within`, when neither side of the trigger has room for the whole menu */
  maxHeight: Ref<number | null>;
  place: () => void;
} {
  const atStart = ref(false);
  const centered = ref(false);
  const above = ref(false);
  const shift = ref(0);
  const maxHeight = ref<number | null>(null);

  // A MENU LEFT OPEN WHILE THE WINDOW CHANGES SIZE IS PLACED AGAIN. It was measured once
  // per open on the argument that a menu can't resize while it is up, which is true of
  // the menu and not of the window: a phone turned on its side, a desktop window dragged
  // narrower, a browser pane snapping from one width to another. The row reflows, the
  // trigger moves, and the card stayed where the old layout had put it: one opened under
  // a mark at 1024px was 7px off the left edge when the window dropped to 405 and the
  // mark moved to x=122 (2026-11-27, and how it was found).
  // Placed again, NOT closed: on engines where the on-screen keyboard resizes the window,
  // closing would shut a card the moment its own field was tapped.
  // The listener exists only from a menu's first place() until the first resize that
  // finds its list gone, so a list of 150 rows carries one for each menu that is or was
  // lately open, not one per row.
  let watching = false;
  const unwatch = () => {
    window.removeEventListener("resize", onResize);
    watching = false;
  };
  function onResize(): void {
    if (listRef.value?.isConnected) place();
    else unwatch();
  }
  if (getCurrentScope()) onScopeDispose(unwatch);

  function place(): void {
    const list = listRef.value;
    const anchor = list?.offsetParent as HTMLElement | null;
    if (!list || !anchor) return;
    if (!watching) {
      window.addEventListener("resize", onResize, { passive: true });
      watching = true;
    }

    // Measure the anchor, and the list's own WIDTH and HEIGHT only — its current top
    // and left depend on whichever sides it is hanging from right now, so compute the
    // candidates rather than trusting where it happens to be sitting.
    //
    // offsetWidth/offsetHeight, NOT a client rect: this runs on the tick the menu
    // mounts, while the enter transform (translateY + scale(0.98)) is still applied,
    // and a rect reports the TRANSFORMED box. The offset pair is the untransformed
    // layout box. Same trap Tooltip.vue documents; the ANCHOR isn't
    // animating, so its rect is sound.
    const a = anchor.getBoundingClientRect();
    const w = list.offsetWidth;
    // scrollHeight, not offsetHeight: a cap from the previous open is still on the
    // card at this point, and the fit test needs the whole menu's height
    const h = opts.within ? list.scrollHeight : list.offsetHeight;
    // the gaps below are px at the base type size and grow with it past 1920px, as the
    // CSS spacing around the menu does (utils/typeScale)
    const scale = typeScale();
    const edge = EDGE_PADDING * scale;
    const gap = ANCHOR_GAP * scale;

    const trailingLeft = a.right - w; // the default: right edges flush
    const leadingRight = a.left + w; // the flip: left edges flush

    // clientWidth, not innerWidth: the visible edge is the layout viewport's, and
    // innerWidth also counts a classic scrollbar's column (Windows, Linux), so a menu
    // could be judged to fit with its last 15px under the scrollbar.
    const viewportWidth = document.documentElement.clientWidth;
    centered.value = false;
    if (opts.fit === "center" && w <= viewportWidth - 2 * edge) {
      // middle to middle, then the least slide that keeps both edges on screen
      const centredLeft = a.left + a.width / 2 - w / 2;
      const kept = Math.min(Math.max(centredLeft, edge), viewportWidth - edge - w);
      centered.value = true;
      atStart.value = false;
      shift.value = Math.round(kept - centredLeft);
    } else if (opts.fit === "shift") {
      // slide by the exact overrun, measured off the rendered card rather than a
      // constant: its width is set in CSS (rem), so a hardcoded pixel twin is wrong
      // the moment the root font size isn't 16, and drifts if the rule is retuned
      shift.value = trailingLeft < edge ? edge - trailingLeft : 0;
    } else {
      // Prefer the side asked for. Only flip when it would overrun its edge AND the
      // flip actually fits — a menu wider than the viewport is beyond helping, and
      // flipping it would just move which edge it's cut off at.
      const startFits = leadingRight <= viewportWidth - edge;
      const endFits = trailingLeft >= edge;
      atStart.value = opts.side === "start" ? startFits || !endFits : !endFits && startFits;
    }

    // Same rule downward, and the same preference: below unless below doesn't fit and
    // above does. ONE fit test for both kinds of menu, measured against the window or
    // (`within`) the card that clips it: it was written out once for each, and only one
    // of the two copies learned the type scale.
    const { top, bottom } = opts.within ? verticalBounds(anchor, edge) : { top: edge, bottom: window.innerHeight - edge };
    const roomBelow = bottom - (a.bottom + gap);
    const roomAbove = a.top - gap - top;
    // Neither side holds it. A `within` menu takes the roomier side and is capped to
    // that room. Any other stays below at its own height, which is the right answer for
    // a menu TALLER than the viewport: flipping it would only change which end is cut
    // off, and below at least leaves its first row against the trigger you just pressed.
    const capped = !!opts.within && h > roomBelow && h > roomAbove;
    above.value = capped ? roomAbove > roomBelow : h > roomBelow && h <= roomAbove;
    maxHeight.value = capped
      ? Math.max(MIN_CAPPED_HEIGHT * scale, Math.floor(Math.max(roomAbove, roomBelow)))
      : null;
  }

  return { atStart, centered, above, shift, maxHeight, place };
}
