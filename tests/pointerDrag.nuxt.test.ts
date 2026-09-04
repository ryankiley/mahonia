// @vitest-environment nuxt
//
// The shared drag scaffold. It has no tests and four callers — the editor's item
// rows and folders, the in-editor vault pane, and /vault — so a change here moves
// every drag-to-reorder gesture on the site at once. It needs a DOM (window
// listeners, elementFromPoint, pointer capture) but no Nuxt app; it's on the nuxt
// environment because that's where this repo keeps its DOM tests.
//
// Two of the cases below are regressions that actually shipped and had to be
// found by hand:
//   • `within` was a hardcoded `.editor__body`. On /vault that element doesn't
//     exist, so `outside` computed true on every move and EVERY drag silently
//     cancelled at the drop — no error, no indicator, nothing.
//   • reset() runs BEFORE commit() on release, so a hook that clears the caller's
//     pending target in onReset destroyed the payload commit was about to use.
//     target() is therefore read first, deliberately.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPointerDrag, createPressArm } from "~/utils/pointerDrag";

// happy-dom has no layout, so elementFromPoint returns null and getBoundingClientRect
// is all zeroes. Both are stubbed per-test: the scaffold's decisions are ABOUT those
// two readings, so faking them is faking the input, not the logic.
let hitEl: HTMLElement | null = null;
beforeEach(() => {
  hitEl = null;
  document.body.innerHTML = "";
  document.elementFromPoint = (() => hitEl) as typeof document.elementFromPoint;
  // jsdom/happy-dom don't implement pointer capture; the scaffold already treats a
  // throw as "unsupported", and these assert the surrounding behaviour either way
  document.documentElement.setPointerCapture = vi.fn();
  document.documentElement.releasePointerCapture = vi.fn();
});
afterEach(() => {
  document.body.innerHTML = "";
});

/** A surface element whose vertical band is [top, bottom]. */
function surface(selectorClass: string, top: number, bottom: number): HTMLElement {
  const el = document.createElement("div");
  el.className = selectorClass;
  el.getBoundingClientRect = (() => ({ top, bottom, left: 0, right: 500, width: 500, height: bottom - top })) as never;
  document.body.appendChild(el);
  return el;
}

const down = (pointerId = 1) => new PointerEvent("pointerdown", { pointerId, clientX: 10, clientY: 50 });
const move = (clientY: number, pointerId = 1) =>
  new PointerEvent("pointermove", { pointerId, clientX: 10, clientY, bubbles: true });
const up = (pointerId = 1, altKey = false) => new PointerEvent("pointerup", { pointerId, bubbles: true, altKey });
const key = (type: "keydown" | "keyup", k: string, altKey: boolean) =>
  new KeyboardEvent(type, { key: k, altKey });

/** A drag wired to a fixed target, with the calls it made recorded. */
function harness(opts: { within?: string; target?: () => unknown } = {}) {
  // `copies` is kept beside `commit` rather than as a third element in it, so the
  // cases that predate the copy modifier still assert the pair they were written for
  const calls = {
    commit: [] as [string, unknown][],
    copies: [] as boolean[],
    reset: 0,
    start: 0,
    tracked: [] as (HTMLElement | null)[],
  };
  const drag = createPointerDrag<unknown>({
    track: (_ev, el) => void calls.tracked.push(el),
    target: opts.target ?? (() => "drop-target"),
    commit: (id, t, copy) => {
      calls.commit.push([id, t]);
      calls.copies.push(copy);
    },
    onStart: () => void calls.start++,
    onReset: () => void calls.reset++,
    within: opts.within,
  });
  return { drag, calls };
}

describe("createPointerDrag", () => {
  it("commits to the last target on a release inside the surface", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(move(200));
    window.dispatchEvent(up());

    expect(calls.commit).toEqual([["row-1", "drop-target"]]);
    expect(drag.dragId.value).toBeNull();
  });

  // The /vault regression. A surface selector that matches nothing must mean "no
  // band to escape from", NOT "always outside" — the latter cancels every drop.
  it("commits when the named surface isn't on the page at all", () => {
    const { drag, calls } = harness({ within: ".not-on-this-page" });

    drag.start("row-1", down());
    window.dispatchEvent(move(200));
    window.dispatchEvent(up());

    expect(calls.commit).toEqual([["row-1", "drop-target"]]);
  });

  it("cancels a release that escaped above or below the surface", () => {
    surface("editor__body", 100, 300);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(move(40)); // up over the sticky topbar
    window.dispatchEvent(up());
    expect(calls.commit).toEqual([]);

    drag.start("row-2", down());
    window.dispatchEvent(move(900)); // down past the footer
    window.dispatchEvent(up());
    expect(calls.commit).toEqual([]);
  });

  // Dragging a row rightward off its own edge is how nesting works, so the
  // horizontal margin must stay a valid drop — only a VERTICAL escape cancels.
  it("treats the side margins as inside", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 4000, clientY: 200 }));
    window.dispatchEvent(up());

    expect(calls.commit).toEqual([["row-1", "drop-target"]]);
  });

  // reset() runs before commit() so the caller's onReset can clear its own state.
  // That means target() has to be read FIRST — a hook that stores its payload in
  // the state onReset clears would otherwise commit nothing.
  it("reads the target before reset clears the caller's state", () => {
    surface("editor__body", 0, 400);
    // a caller whose onReset wipes its own pending target, as /vault's did
    let pendingTarget: string | null = "the-payload";
    const order: string[] = [];
    const drag = createPointerDrag<string>({
      track: () => {},
      target: () => {
        order.push("target");
        return pendingTarget;
      },
      commit: (id, t) => order.push(`commit:${id}:${t}`),
      onReset: () => {
        order.push("reset");
        pendingTarget = null;
      },
      within: ".editor__body",
    });

    drag.start("row-1", down());
    window.dispatchEvent(move(200));
    window.dispatchEvent(up());

    expect(order).toEqual(["target", "reset", "commit:row-1:the-payload"]);
  });

  it("commits nothing when there is no target", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body", target: () => null });

    drag.start("row-1", down());
    window.dispatchEvent(move(200));
    window.dispatchEvent(up());

    expect(calls.commit).toEqual([]);
    expect(calls.reset).toBe(1);
  });

  it("aborts on Escape without committing", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(move(200));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(calls.commit).toEqual([]);
    expect(drag.dragId.value).toBeNull();
    // ...and the listeners really are gone — a later release must not commit
    window.dispatchEvent(up());
    expect(calls.commit).toEqual([]);
  });

  it("aborts on pointercancel — the touch gesture the OS steals", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));

    expect(calls.commit).toEqual([]);
    expect(drag.dragId.value).toBeNull();
  });

  // On touch the window listeners hear EVERY pointer. A second finger tapping
  // elsewhere would otherwise commit the drag wherever the indicator happens to
  // sit, or cancel it, while finger one is still holding the row.
  it("ignores a second finger's up, move and cancel", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down(1));
    window.dispatchEvent(move(200, 1));
    const trackedBefore = calls.tracked.length;

    window.dispatchEvent(move(999, 2)); // other finger, way outside
    expect(calls.tracked.length).toBe(trackedBefore); // not tracked
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 2 }));
    expect(drag.dragId.value).toBe("row-1"); // still dragging
    window.dispatchEvent(up(2));
    expect(calls.commit).toEqual([]); // and it didn't commit

    window.dispatchEvent(up(1)); // the real finger releases
    expect(calls.commit).toEqual([["row-1", "drop-target"]]);
  });

  it("does not stack listeners when a second drag starts mid-gesture", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    drag.start("row-2", down()); // re-entrant pickup
    window.dispatchEvent(move(200));
    window.dispatchEvent(up());

    // exactly one commit, for the SECOND row — not one per attached listener set
    expect(calls.commit).toEqual([["row-2", "drop-target"]]);
  });

  it("locks text selection while dragging and releases it after", () => {
    surface("editor__body", 0, 400);
    const { drag } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    expect(document.body.style.userSelect).toBe("none");
    window.dispatchEvent(up());
    expect(document.body.style.userSelect).toBe("");
  });
});

// The press that BECOMES a drag — the arming scaffold /vault's rows and the vault
// pane's rows both sit on. The semantics that must not move: distance is checked
// BEFORE time (a sub-threshold wobble mid-hold doesn't stand a touch press down),
// a pre-hold move stands down rather than deferring, and the press record is
// consumed before onDrag runs.
describe("createPressArm", () => {
  const pdown = (init: PointerEventInit = {}) =>
    new PointerEvent("pointerdown", { pointerId: 1, clientX: 10, clientY: 50, ...init });
  const pmove = (init: PointerEventInit = {}) =>
    new PointerEvent("pointermove", { pointerId: 1, clientX: 10, clientY: 50, bubbles: true, ...init });
  /** The hold rule compares event timestamps, which happy-dom stamps at
   *  construction — so the touch tests pin them to known values instead. */
  const at = <E extends Event>(ev: E, t: number): E => {
    Object.defineProperty(ev, "timeStamp", { value: t });
    return ev;
  };
  function armHarness(opts: { touchHoldMs?: number; exclude?: string } = {}) {
    const drags: [unknown, PointerEvent][] = [];
    const arm = createPressArm<unknown>({
      threshold: 5,
      onDrag: (payload, ev) => void drags.push([payload, ev]),
      ...opts,
    });
    return { arm, drags };
  }

  it("hands off to onDrag once the press travels past the threshold", () => {
    const { arm, drags } = armHarness();
    arm.start("row-1", pdown());
    window.dispatchEvent(pmove({ clientX: 40 }));
    expect(drags).toEqual([["row-1", expect.any(PointerEvent)]]);
    expect(drags[0]![1].type).toBe("pointermove"); // the arming move, not the down
    // the press was consumed — more travel is the drag's business, not a second one
    window.dispatchEvent(pmove({ clientX: 90 }));
    expect(drags).toHaveLength(1);
  });

  it("a press that never travels is not a drag", () => {
    const { arm, drags } = armHarness();
    arm.start("row-1", pdown());
    window.dispatchEvent(pmove({ clientX: 12 })); // 2px — under the threshold
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    // the release ended the press — a later sweep must not resurrect it
    window.dispatchEvent(pmove({ clientX: 200 }));
    expect(drags).toEqual([]);
  });

  it("ignores another pointer's moves", () => {
    const { arm, drags } = armHarness();
    arm.start("row-1", pdown({ pointerId: 1 }));
    window.dispatchEvent(pmove({ pointerId: 2, clientX: 200 }));
    expect(drags).toEqual([]);
    window.dispatchEvent(pmove({ pointerId: 1, clientX: 40 }));
    expect(drags).toHaveLength(1);
  });

  it("a press on an excluded control is left alone", () => {
    const { arm, drags } = armHarness({ exclude: "select, button" });
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    const ev = pdown();
    btn.dispatchEvent(ev); // sets ev.target the way a real handler would see it
    arm.start("row-1", ev);
    window.dispatchEvent(pmove({ clientX: 200 }));
    expect(drags).toEqual([]);
  });

  it("with an exclusion set, a press on the row itself still arms", () => {
    const { arm, drags } = armHarness({ exclude: "select, button" });
    const row = document.createElement("li");
    document.body.appendChild(row);
    const ev = pdown();
    row.dispatchEvent(ev);
    arm.start("row-1", ev);
    window.dispatchEvent(pmove({ clientX: 200 }));
    expect(drags).toHaveLength(1);
  });

  it("a non-primary button never arms", () => {
    const { arm, drags } = armHarness();
    arm.start("row-1", pdown({ button: 2 }));
    window.dispatchEvent(pmove({ clientX: 200 }));
    expect(drags).toEqual([]);
  });

  it("pointercancel stands the press down — the touch scroll the browser steals", () => {
    const { arm, drags } = armHarness();
    arm.start("row-1", pdown());
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
    window.dispatchEvent(pmove({ clientX: 200 }));
    expect(drags).toEqual([]);
  });

  // The pane's touch rule: a finger that moves before the hold elapses is
  // scrolling, and the press stands down rather than hijacking the swipe.
  it("touch: movement past the threshold before the hold elapses stands down", () => {
    const { arm, drags } = armHarness({ touchHoldMs: 250 });
    arm.start("row-1", at(pdown({ pointerType: "touch" }), 1000));
    window.dispatchEvent(at(pmove({ pointerType: "touch", clientX: 40 }), 1100)); // 100ms in
    expect(drags).toEqual([]);
    // and it STOOD DOWN — movement after the hold can't revive the press
    window.dispatchEvent(at(pmove({ pointerType: "touch", clientX: 90 }), 1400));
    expect(drags).toEqual([]);
  });

  it("touch: a held finger drags; a sub-threshold wobble mid-hold doesn't stand it down", () => {
    const { arm, drags } = armHarness({ touchHoldMs: 250 });
    arm.start("row-1", at(pdown({ pointerType: "touch" }), 1000));
    // 2px of wobble during the hold: under the threshold, so the press survives —
    // distance is checked before time, as it always was
    window.dispatchEvent(at(pmove({ pointerType: "touch", clientX: 12 }), 1100));
    window.dispatchEvent(at(pmove({ pointerType: "touch", clientX: 40 }), 1300)); // past the hold
    expect(drags).toEqual([["row-1", expect.any(PointerEvent)]]);
  });

  it("touch without a hold configured arms by distance alone — /vault's rows", () => {
    const { arm, drags } = armHarness(); // no touchHoldMs
    arm.start("row-1", at(pdown({ pointerType: "touch" }), 1000));
    window.dispatchEvent(at(pmove({ pointerType: "touch", clientX: 40 }), 1001));
    expect(drags).toHaveLength(1);
  });

  it("a second press replaces the first instead of stacking", () => {
    const { arm, drags } = armHarness();
    arm.start("row-1", pdown());
    arm.start("row-2", pdown());
    window.dispatchEvent(pmove({ clientX: 40 }));
    expect(drags).toEqual([["row-2", expect.any(PointerEvent)]]);
  });

  it("end() — the unmount path — detaches everything", () => {
    const { arm, drags } = armHarness();
    arm.start("row-1", pdown());
    arm.end();
    window.dispatchEvent(pmove({ clientX: 200 }));
    expect(drags).toEqual([]);
  });
});

// The copy modifier — Alt held means "copy instead of move" (the editor's item rows
// duplicate a row on an Alt-drag). The scaffold owns it because it is the only thing
// that sees every event in a gesture: the modifier can go down and up with the pointer
// perfectly still, so a reading taken only on pointermove goes stale in the hand.
describe("the copy modifier", () => {
  it("copies when Alt is armed mid-drag, even picked up bare", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 10, clientY: 200, altKey: true }));
    window.dispatchEvent(up(1, true));
    expect(calls.copies).toEqual([true]);
  });

  // THE ONE THAT SHIPPED BROKEN. Letting go of Alt and the mouse button is a single
  // two-handed motion and the key almost always lifts first, so a decision read off
  // the release event turned the copy into a silent MOVE — no error, nothing to see,
  // the row just relocated and the gesture read as not existing.
  it("still copies when Alt lifts a moment before the button", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 10, clientY: 200, altKey: true }));
    // the key goes up first, the pointer never moves again, THEN the button
    window.dispatchEvent(key("keyup", "Alt", false));
    window.dispatchEvent(up(1, false));
    expect(calls.copies).toEqual([true]);
  });

  // …and the other half of the latch: movement is what disarms it, which is the only
  // signal that separates "letting go to drop" from "changed my mind".
  it("drops the copy when Alt is released and the drag carries on", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 10, clientY: 200, altKey: true }));
    window.dispatchEvent(key("keyup", "Alt", false));
    window.dispatchEvent(move(240)); // carried on dragging without it
    window.dispatchEvent(up(1, false));
    expect(calls.copies).toEqual([false]);
  });

  it("does not copy a drag that never touched the modifier", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(move(200));
    window.dispatchEvent(up());
    expect(calls.copies).toEqual([false]);
  });

  it("arms from a keypress alone, with the pointer sitting still", () => {
    surface("editor__body", 0, 400);
    const { drag } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(move(200));
    expect(drag.copyKey.value).toBe(false);

    // no pointermove between these — pressing Alt is a key event and nothing else
    window.dispatchEvent(key("keydown", "Alt", true));
    expect(drag.copyKey.value).toBe(true);
    // and a keyup does NOT disarm it: that is the release-order trap. The cursor
    // keeps saying "copy" because a drop here would still be one.
    window.dispatchEvent(key("keyup", "Alt", false));
    expect(drag.copyKey.value).toBe(true);
    // only movement re-reads the live state
    window.dispatchEvent(move(240));
    expect(drag.copyKey.value).toBe(false);
  });

  it("drops the modifier with the gesture", () => {
    surface("editor__body", 0, 400);
    const { drag } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(key("keydown", "Alt", true));
    expect(drag.copyKey.value).toBe(true);
    window.dispatchEvent(up(1, true));
    // a drag that ended holds no modifier — the rows read this live for the copy
    // cursor, and a stale `true` would light the next gesture before it began
    expect(drag.copyKey.value).toBe(false);
  });

  // Escape still aborts, and must not be mistaken for a modifier reading on the way
  it("still cancels on Escape once the modifier shares the listener", () => {
    surface("editor__body", 0, 400);
    const { drag, calls } = harness({ within: ".editor__body" });

    drag.start("row-1", down());
    window.dispatchEvent(move(200));
    window.dispatchEvent(key("keydown", "Escape", false));
    window.dispatchEvent(up());

    expect(calls.commit).toEqual([]);
    expect(drag.dragId.value).toBeNull();
  });
});
