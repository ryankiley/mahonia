// The room a phone's keyboard leaves, and what the surfaces that live in it do about it.
//
// Everything here is measured against the VISUAL viewport — the part of the page actually
// on screen — because that is the only one that knows about the keyboard. iOS keeps the
// LAYOUT viewport full height while the keyboard is up and pans a shorter visual viewport
// inside it, and getBoundingClientRect() answers in layout coordinates, so "on screen" is
// [vv.offsetTop, vv.offsetTop + vv.height] in the same coordinates a rect is read in.
// Android does the same unless the page asks for `interactive-widget=resizes-content`
// (nuxt.config.ts does), and then the two viewports agree and every keyboard term below
// reads 0 — the layout itself has moved out of the keyboard's way.
//
// Three readers, one model: the add-item suggestions (ItemInput) size and place their
// menu in the band; the editor (GearEditor's onFocusIn) lifts a field that opens one; and
// the phone vault sheet (VaultPane) rides above the keyboard instead of under it. The DOM
// reads are kept in two small functions so the decisions themselves are pure and tested
// (tests/viewportRoom.test.ts).
//
// Import-free, like app/utils/vaultPane.ts: the editor's first-load chunk reaches it.

/** A vertical stretch of the page, in layout coordinates (what a client rect reads). */
export interface Band {
  top: number;
  bottom: number;
}

/**
 * What's on screen and usable, in layout coordinates: from under the sticky topbar (or
 * the visual viewport's top, when a keyboard pan has carried the bar out of view) down to
 * the visual viewport's bottom — the keyboard's top edge while it is up.
 *
 * Every `.topbar` is asked, and the lowest bottom wins. There is one on any page this
 * runs on (the editor's own, or the site's), and a bar that isn't rendered measures 0.
 */
export function visibleBand(): Band {
  const vv = window.visualViewport;
  const top = vv?.offsetTop ?? 0;
  const bottom = top + (vv?.height ?? window.innerHeight);
  let bar = 0;
  for (const el of document.querySelectorAll(".topbar")) bar = Math.max(bar, el.getBoundingClientRect().bottom);
  return { top: Math.max(top, bar), bottom };
}

/**
 * How much of the LAYOUT viewport's bottom the keyboard covers: the strip under the
 * visual viewport. 0 with no keyboard, and 0 on Android under `resizes-content`, where
 * the layout viewport shrinks instead. Rounded, and anything under a pixel is 0, so the
 * sub-pixel jitter a URL bar's collapse leaves in the two heights moves nothing.
 */
export function keyboardInset(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  const kb = Math.round(innerHeight - vvHeight - vvOffsetTop);
  return kb >= 1 ? kb : 0;
}

/**
 * Where a suggestion menu hanging off a field should open, and how tall it may be.
 *
 * Below is the default and stays the default whenever it has `min` of room: the menu
 * hangs off the field it was typed into, and a list that jumps above the field on some
 * rows and not others is harder to read than a shorter list in the usual place. It flips
 * ABOVE only when below has less than that AND above has more — a field at the foot of
 * the screen with the keyboard up, after the editor has already tried to lift it (see
 * liftForSuggestions) and the page had no more scroll to give.
 *
 * `room` is the height the menu may take on the side it opens: the band's distance from
 * the anchor, less the gap the menu sits off it and an `edge` of breathing room from the
 * keyboard or the topbar. Never below `floor` (about one row): a menu squeezed to its
 * own padding is an empty card, and one row reaching under the keyboard says more.
 */
export function menuRoom(
  anchor: Band,
  band: Band,
  opts: { gap: number; edge: number; min: number; floor: number },
): { above: boolean; room: number } {
  const below = band.bottom - anchor.bottom - opts.gap - opts.edge;
  const above = anchor.top - band.top - opts.gap - opts.edge;
  const flip = below < opts.min && above > below;
  return { above: flip, room: Math.round(Math.max(opts.floor, flip ? above : below)) };
}

/**
 * How far to scroll the page so a field whose suggestions open BELOW it has the screen
 * under it for them: when the field's middle is in the lower half of what's on screen
 * (`view`), the distance that brings its top up to `margin` under `ceiling` (the topbar's
 * bottom, or the screen's top). 0 when it is already in the upper half — there the menu
 * has room and moving the page would only lose your place.
 *
 * Positive scrolls the page down, which moves the field up. Never negative: this only
 * ever makes room below.
 */
export function liftForSuggestions(field: Band, view: Band, ceiling: number, margin: number): number {
  const mid = (field.top + field.bottom) / 2;
  if (mid <= (view.top + view.bottom) / 2) return 0;
  return Math.max(0, Math.round(field.top - (ceiling + margin)));
}
