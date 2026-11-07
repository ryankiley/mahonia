// The keyboard arithmetic behind three phone fixes: the add-item suggestions that opened
// behind the keyboard, the editor lifting the field that opens them, and the My Gear sheet
// that the keyboard covered. Pure numbers in, decisions out — the DOM reads that feed them
// (visibleBand, the visual viewport) need a real phone, so what's pinned here is what the
// numbers MEAN. The scene is an iPhone-sized layout viewport, 844px tall, with a 61px
// sticky topbar; with the keyboard up the visual viewport is the top 508px of it.
import { describe, expect, it } from "vitest";
import { keyboardInset, liftForSuggestions, menuRoom } from "../app/utils/viewportRoom";

const OPTS = { gap: 4, edge: 8, min: 120, floor: 56 };
/** what's usable with the keyboard up: under the bar, down to the keyboard's top edge */
const KB_UP = { top: 61, bottom: 508 };

describe("keyboardInset", () => {
  it("is the strip under the visual viewport", () => {
    expect(keyboardInset(844, 508, 0)).toBe(336);
  });

  // iOS pans the visual viewport to keep a focused field in view; what the keyboard
  // covers is still everything below the visual viewport's bottom
  it("counts the visual viewport's pan", () => {
    expect(keyboardInset(844, 508, 120)).toBe(216);
  });

  it("is 0 with no keyboard, and 0 under Android's resizes-content", () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
    // the layout viewport shrank with the keyboard, so the two agree
    expect(keyboardInset(508, 508, 0)).toBe(0);
  });

  // a collapsing URL bar leaves sub-pixel differences between the two heights; the sheet
  // must not twitch on them
  it("ignores sub-pixel jitter", () => {
    expect(keyboardInset(844, 843.6, 0)).toBe(0);
  });
});

describe("menuRoom", () => {
  // THE REPORT: a field in the lower half, keyboard up — the menu was capped at 50dvh
  // (422px), hung below the field, and every row of it sat behind the keyboard
  it("caps a menu below a low field to the room above the keyboard", () => {
    const r = menuRoom({ top: 300, bottom: 340 }, KB_UP, OPTS);
    expect(r).toEqual({ above: false, room: 508 - 340 - 4 - 8 });
  });

  // after the editor lifted the field to the top, the menu gets the screen
  it("gives a lifted field the whole strip under it", () => {
    const r = menuRoom({ top: 73, bottom: 113 }, KB_UP, OPTS);
    expect(r.above).toBe(false);
    expect(r.room).toBe(383);
  });

  it("flips above only when below has less than a few rows and above has more", () => {
    // the page had no more scroll to give: the field is stuck at the foot of the strip
    const r = menuRoom({ top: 430, bottom: 470 }, KB_UP, OPTS);
    expect(r).toEqual({ above: true, room: 430 - 61 - 4 - 8 });
  });

  it("stays below when below is short but above is shorter", () => {
    const tight = { top: 61, bottom: 200 };
    const r = menuRoom({ top: 80, bottom: 120 }, tight, OPTS);
    expect(r.above).toBe(false);
  });

  // a menu squeezed to its own padding is an empty card; a row reaching under the
  // keyboard at least says something
  it("never sizes a menu below its floor", () => {
    const r = menuRoom({ top: 490, bottom: 530 }, { top: 470, bottom: 508 }, OPTS);
    expect(r.room).toBe(56);
  });

  // desktop, no keyboard: a field halfway down a tall window keeps the usual menu
  it("leaves a roomy field alone", () => {
    const r = menuRoom({ top: 400, bottom: 440 }, { top: 61, bottom: 1000 }, OPTS);
    expect(r).toEqual({ above: false, room: 548 });
  });
});

describe("liftForSuggestions", () => {
  const view = { top: 0, bottom: 508 };

  it("brings a field in the lower half up to just under the topbar", () => {
    // field at 380–420 (middle 400, past the 254 midline) → top lands at 61 + 12
    expect(liftForSuggestions({ top: 380, bottom: 420 }, view, 61, 12)).toBe(380 - 73);
  });

  // in the upper half the menu already has the room, and moving the page would only
  // lose your place
  it("leaves a field in the upper half where you tapped it", () => {
    expect(liftForSuggestions({ top: 120, bottom: 160 }, view, 61, 12)).toBe(0);
  });

  // a field the keyboard has hidden altogether is in the lower half too
  it("rescues a field under the keyboard", () => {
    expect(liftForSuggestions({ top: 600, bottom: 640 }, view, 61, 12)).toBe(600 - 73);
  });

  // halves are of what's ON SCREEN: with the visual viewport panned down 200px, a field
  // at 380 is in its upper half
  it("measures the halves against the panned visual viewport", () => {
    expect(liftForSuggestions({ top: 380, bottom: 420 }, { top: 200, bottom: 708 }, 200, 12)).toBe(0);
  });

  it("never scrolls the other way", () => {
    expect(liftForSuggestions({ top: 60, bottom: 500 }, view, 61, 12)).toBe(0);
  });
});
