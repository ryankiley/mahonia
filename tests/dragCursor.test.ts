// The copy-drag cursor's one invariant: it is declared on the editing SURFACE, and it
// reaches the surface's descendants.
//
// This is a correctness rule wearing a style rule's clothes, and it shipped wrong once
// on the way in. The obvious place to say "this drag copies" is the row being dragged:
//
//   .item-wrap.is-dragging.is-copying { cursor: copy; }
//
// …which computes exactly `copy`, applies to exactly the right element, and does
// nothing at all. A lifted row is `pointer-events: none` for the length of the gesture
// — deliberately, so the drop detection's elementFromPoint sees the rows underneath it
// rather than the row in flight — and an element the pointer cannot hit never gets to
// say what the cursor is. Measured mid-drag, the rule computed `copy` on the lifted row
// while the pointer showed `auto`, because the element actually under it was the row
// below.
//
// So the declaration has to sit on `.editor__body[data-copying]` AND on its
// descendants: every row, field, grip and button in reach sets a cursor of its own, and
// for the length of the gesture none of them may win.
//
// Asserting on the COMPILED sheet, for the reason printStyles.test.ts gives: it is the
// emitted CSS that competes in the cascade, and compiling also proves the rule survives
// whatever @use graph main.scss grows. The failure mode is invisible on screen — the
// drag still works, it just stops saying what it is about to do — so nothing else
// catches a regression to the row-scoped form. A DOM test can't stand in for it either:
// driving the drag with synthetic PointerEvents means setPointerCapture throws (there
// is no real pointer with that id) and the scaffold swallows it, so the captured-pointer
// case — the one that shipped wrong — never happens under test. Hence a cascade
// assertion rather than a behavioural one.
//
// The other half of the pair — `.item-wrap.is-dragging { pointer-events: none }`, the
// lift that makes the row unhittable in the first place — is NOT asserted here: it
// lives in ItemRow's scoped block, which never reaches main.scss, so this file cannot
// see it. If that lift is ever dropped, these tests keep passing and the rule below
// merely becomes belt-and-braces rather than wrong.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as sass from "sass";

const ENTRY = fileURLToPath(new URL("../app/assets/styles/main.scss", import.meta.url));

describe("the copy-drag cursor", () => {
  const css = sass.compile(ENTRY, { style: "expanded", sourceMap: false }).css;
  // every selector list that declares `cursor: copy`
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*cursor:\s*copy[^{}]*\}/g)].map((m) =>
    m[1]!.trim().replace(/\s+/g, " "),
  );

  it("is declared at all", () => {
    expect(selectors, "no rule in the compiled sheet sets cursor: copy").not.toEqual([]);
  });

  it("hangs off the surface's data-copying attribute, not off the dragged row", () => {
    const rule = selectors.join(" | ");
    expect(rule).toContain(".editor__body[data-copying]");
    // the exact shape that shipped broken: a lifted row can't set a cursor, because
    // it is pointer-events:none and never hit-tested
    expect(rule).not.toContain(".is-dragging");
  });

  it("reaches the descendants, or every control it passes over overrides it", () => {
    expect(selectors.join(" | ")).toContain(".editor__body[data-copying] *");
  });

  // The second way this was wrong. The gesture holds pointer capture on
  // document.documentElement, and a captured pointer takes its cursor from the
  // CAPTURING element — <html>, which is an ancestor of the surface and so cannot be
  // reached by any descendant selector. Only :root:has() gets there.
  it("reaches <html>, which owns the cursor while the pointer is captured", () => {
    expect(selectors.join(" | ")).toMatch(/:root:has\(\s*\.editor__body\[data-copying\]/);
  });
});
