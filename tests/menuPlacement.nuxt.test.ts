// Which side of its trigger a menu hangs from (useMenuPlacement), on the vertical axis:
// below unless below doesn't hold it and above does.
//
// The distances it keeps (8px from an edge, 4px off the trigger) are px at the base type
// size and grow with the type on a window past 1920px, as the CSS spacing around the
// menu does. The rule was once written twice, for a menu fitted to the window and for
// one fitted `within` a clipping card, and only the second was taught the scale: a
// row's menu on a wide screen was still judged against 8 and 4, so it could be called
// a fit below with its last row closer to the window's floor than the gap allows, or
// flipped above into less room than it needs.
//
// The DOM here answers only what place() reads: the anchor's rect, the list's layout
// box, the window's height, and the type scale (utils/typeScale, stubbed).
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMenuPlacement } from "~/composables/useMenuPlacement";

const scale = vi.hoisted(() => ({ value: 1 }));
vi.mock("~/utils/typeScale", () => ({ typeScale: () => scale.value }));

const rect = (top: number, bottom: number, left = 500, right = 540) =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect;

function viewport(height: number, width = 1000) {
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
}

/** A menu `h` tall hanging off a trigger at `top`..`bottom`, optionally inside a card
 *  that clips at `clip`. Answers the placement after one place(). */
function placed(o: {
  top: number;
  bottom: number;
  h: number;
  within?: boolean;
  clip?: { top: number; bottom: number };
}) {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () => rect(o.top, o.bottom);
  const list = document.createElement("ul");
  Object.defineProperties(list, {
    offsetParent: { get: () => anchor },
    offsetWidth: { get: () => 120 },
    offsetHeight: { get: () => o.h },
    scrollHeight: { get: () => o.h },
  });
  anchor.append(list);
  if (o.clip) {
    const card = document.createElement("div");
    card.style.overflowY = "hidden";
    card.getBoundingClientRect = () => rect(o.clip!.top, o.clip!.bottom);
    card.append(anchor);
    document.body.append(card);
  } else {
    document.body.append(anchor);
  }
  const p = useMenuPlacement(ref(list), { within: o.within });
  p.place();
  return { above: p.above.value, maxHeight: p.maxHeight.value };
}

afterEach(() => {
  scale.value = 1;
  document.body.replaceChildren();
});

describe("a menu fitted to the window, on a screen where the type has grown", () => {
  // at twice the base size the edge is 16px and the gap off the trigger 8px

  it("flips above when it only fits below by the unscaled distances", () => {
    scale.value = 2;
    viewport(800);
    // below it would end at 580 + 8 + 200 = 788, past the 784 the edge allows
    // (by 4 and 8: 784 against 792, a fit)
    expect(placed({ top: 550, bottom: 580, h: 200 })).toEqual({ above: true, maxHeight: null });
  });

  it("stays below when above only holds it by the unscaled distances", () => {
    scale.value = 2;
    viewport(400);
    // above has 214 - 8 - 16 = 190 of room for 200 (by 4 and 8: 202, a fit)
    expect(placed({ top: 214, bottom: 244, h: 200 })).toEqual({ above: false, maxHeight: null });
  });
});

describe("at the base type size", () => {
  it("a menu fitted to the window hangs below until it would pass the floor's edge", () => {
    viewport(800);
    expect(placed({ top: 270, bottom: 300, h: 200 })).toEqual({ above: false, maxHeight: null });
    // 588 + 4 + 200 = 792, exactly the edge: still a fit
    expect(placed({ top: 558, bottom: 588, h: 200 })).toEqual({ above: false, maxHeight: null });
    expect(placed({ top: 559, bottom: 589, h: 200 })).toEqual({ above: true, maxHeight: null });
  });

  it("and stays below, uncapped, when above doesn't hold it either", () => {
    viewport(400);
    // 212 - 4 - 200 = 8, exactly the edge: fits above
    expect(placed({ top: 212, bottom: 242, h: 200 })).toEqual({ above: true, maxHeight: null });
    expect(placed({ top: 211, bottom: 241, h: 200 })).toEqual({ above: false, maxHeight: null });
  });

  it("a menu fitted within takes the side that holds it, below first", () => {
    viewport(400);
    // 146 of room below the trigger, 200 above it
    expect(placed({ top: 212, bottom: 242, h: 146, within: true })).toEqual({ above: false, maxHeight: null });
    expect(placed({ top: 212, bottom: 242, h: 200, within: true })).toEqual({ above: true, maxHeight: null });
  });

  it("and when neither does, the roomier side, capped to its room", () => {
    viewport(400);
    expect(placed({ top: 212, bottom: 242, h: 201, within: true })).toEqual({ above: true, maxHeight: 200 });
    // 258 below, 88 above
    expect(placed({ top: 100, bottom: 130, h: 300, within: true })).toEqual({ above: false, maxHeight: 258 });
    // 48 on each side: below on a tie, and never capped under the floor of 96
    viewport(150);
    expect(placed({ top: 60, bottom: 90, h: 100, within: true })).toEqual({ above: false, maxHeight: 96 });
  });

  it("measures within the card that clips it, not the window", () => {
    viewport(800);
    const clip = { top: 100, bottom: 500 };
    // inside the card: 158 below the trigger, 188 above it
    expect(placed({ top: 300, bottom: 330, h: 150, within: true, clip })).toEqual({ above: false, maxHeight: null });
    expect(placed({ top: 300, bottom: 330, h: 170, within: true, clip })).toEqual({ above: true, maxHeight: null });
    expect(placed({ top: 300, bottom: 330, h: 200, within: true, clip })).toEqual({ above: true, maxHeight: 188 });
    // the same menu fitted to the window ignores the card: 800 has room below
    expect(placed({ top: 300, bottom: 330, h: 200, clip })).toEqual({ above: false, maxHeight: null });
  });
});


// A menu off a small icon in the middle of a row opens under the icon's middle, and is
// slid only as far as the window makes it. The trigger here is 40 wide and the menu 120.
describe("a menu set on its trigger's middle", () => {
  function centredAt(left: number, width = 1000) {
    viewport(800, width);
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () => rect(100, 120, left, left + 40);
    const list = document.createElement("ul");
    Object.defineProperties(list, {
      offsetParent: { get: () => anchor },
      offsetWidth: { get: () => 120 },
      offsetHeight: { get: () => 100 },
      scrollHeight: { get: () => 100 },
    });
    anchor.append(list);
    document.body.append(anchor);
    const p = useMenuPlacement(ref(list), { fit: "center" });
    p.place();
    return { centered: p.centered.value, shift: p.shift.value, atStart: p.atStart.value };
  }

  it("sits centred, unmoved, where there is room either side", () => {
    expect(centredAt(500)).toEqual({ centered: true, shift: 0, atStart: false });
  });

  it("slides in from the trailing edge by exactly the overrun", () => {
    // centred it would span 900..1020; the window holds it to 872..992
    expect(centredAt(940)).toEqual({ centered: true, shift: -28, atStart: false });
  });

  it("slides in from the leading edge the same way", () => {
    // centred it would span -30..90; it starts at the 8px edge padding
    expect(centredAt(10)).toEqual({ centered: true, shift: 38, atStart: false });
  });

  it("keeps the default when the menu is wider than the window", () => {
    expect(centredAt(20, 100).centered).toBe(false);
  });
});
