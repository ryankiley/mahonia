// The print sheet's one invariant: every declaration inside `@media print` carries
// !important.
//
// This is not a style rule, it is a correctness rule, and it has a history. A global
// class selector — which is all app/assets/styles/print.scss can use, since it has to
// match markup rendered by components it doesn't own — is the weakest thing that can
// match those elements, and it loses two different ways:
//
//   * a component's scoped rule outranks it, because Vue's [data-v-…] suffix adds a
//     whole specificity step;
//   * main.scss's own top-level rules outrank it on source order, because Sass
//     requires @use to precede all other rules, so the print module is always
//     emitted BEFORE the file that uses it. That one has no ordering fix.
//
// Both shipped. `.topbar` printed its sticky bar and bottom hairline for its entire
// life — first beaten by the scoped block in SiteTopbar/GearEditor, then, after that
// block moved to main.scss, beaten by source order instead. `.iname__link` printed a
// dotted underline under every item name on any touch device. Neither failed a test
// and neither looked wrong on screen, which is exactly why this file exists: the
// defect is invisible everywhere except on paper.
//
// Asserting on the COMPILED sheet rather than the .scss source is deliberate — it is
// the emitted CSS that competes in the cascade, and compiling also proves the block
// survives whatever @use graph main.scss grows.
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as sass from "sass";

const ENTRY = fileURLToPath(new URL("../app/assets/styles/main.scss", import.meta.url));

// The compiled `@media print { … }` body, with nested at-rule blocks (@page) removed.
// @page is a page context, not a competitor to any author rule matching an element,
// so its declarations are exempt.
function printBlock(css: string): string {
  const start = css.indexOf("@media print {");
  expect(start, "main.scss no longer emits an @media print block").toBeGreaterThan(-1);

  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  expect(depth, "unbalanced braces in the compiled @media print block").toBe(0);

  return css.slice(start, end).replace(/@page\s*\{[^}]*\}/g, "");
}

describe("print stylesheet", () => {
  const css = sass.compile(ENTRY, { style: "expanded", sourceMap: false }).css;
  const block = printBlock(css);

  // `prop: value;` one per line — sass's expanded output guarantees the shape.
  const declarations = [...block.matchAll(/^\s*(-[\w-]+|[a-z][\w-]*)\s*:\s*([^;]+);/gm)].map((m) => ({
    line: m[0].trim(),
    property: m[1],
    important: /!important$/.test(m[2].trim()),
  }));

  // A floor, not a count — the point is to catch the block vanishing or the parser
  // silently matching nothing, without breaking every time a rule is added or dropped.
  it("emits declarations at all (the block isn't silently empty)", () => {
    expect(declarations.length).toBeGreaterThan(10);
  });

  it("gives every declaration !important, or it does nothing on paper", () => {
    const weak = declarations.filter((d) => !d.important).map((d) => d.line);
    expect(weak).toEqual([]);
  });

  // The two that actually shipped broken. Named explicitly so a regression points at
  // the symptom a reader would recognise rather than at a count.
  it.each([
    ["position", "static", ".topbar — the bar flattens to a title line"],
    ["border-bottom", "0", ".topbar — no rule drawn across the page"],
    ["text-decoration", "none", ".iname__link — no dotted underline under item names"],
  ])("keeps %s: %s !important (%s)", (property, value) => {
    const match = declarations.find((d) => d.property === property && d.line.includes(value));
    expect(match, `no \`${property}: ${value}\` declaration left in @media print`).toBeDefined();
    expect(match!.important).toBe(true);
  });
});
