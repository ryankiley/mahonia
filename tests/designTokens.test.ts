import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOT, stripComments as strip, walkSources } from "./helpers/sources";

// EVERY var(--x) RESOLVES TO SOMETHING THAT DEFINES --x.
//
// This exists because `margin-block-start: var(--space-8)` sat on the About page for an
// unknown length of time doing nothing at all. There was no --space-8 then — the scale
// ran 1-7, then 9 — so the declaration was invalid at computed-value time, the margin
// resolved to 0, and the section rule sat hard against the paragraph above it. Nothing
// reported it. Sass doesn't resolve custom properties, the browser drops the declaration
// silently, and the page still renders, so a typo here is invisible to the build, to the
// type checker and to every other test in this suite. It was found by looking at it.
//
// The trap was the shape of the scale: 1-7 then 9 made --space-8 the natural thing to
// write. The top step is --space-8 now and the scale has no hole, but a name one past
// either end is as easy to write as that one was.
//
// A reference WITH A FALLBACK is deliberate, not a typo — `var(--menu-shift, 0px)` is how
// a centred menu slides only when placement has asked it to — so those are skipped. What's checked
// is the bare form, the one that has nowhere to go when it's wrong.
const files = walkSources(["app"], ["scss", "vue", "ts"]);

// Comments come out first (stripComments). This codebase argues with itself in prose — a
// rule that removed a token routinely says which token it removed, and says it in the
// `var(--x)` form — so a scanner reading raw text would take the explanation for the
// offence and fail on the very comment recording the fix.

// A custom property is DEFINED by a `--name:` declaration anywhere — :root, a scoped
// component rule, inside a media query — or by a component handing an element one at
// runtime. Both runtime forms count, and both are in use: style.setProperty (--vault-span,
// --drag-dy) and a Vue :style binding, whose key is QUOTED — the elevation
// profile positions its hover marker with `:style="{ '--at': ... }"`, and a rule that
// only understood the bare form would call that live token dead.
const defined = new Set<string>();
for (const path of files) {
  const src = strip(readFileSync(path, "utf8"));
  for (const m of src.matchAll(/(--[a-z][a-z0-9-]*)\s*:/gi)) defined.add(m[1]!);
  for (const m of src.matchAll(/["'`](--[a-z][a-z0-9-]*)["'`]\s*:/gi)) defined.add(m[1]!);
  for (const m of src.matchAll(/setProperty\(\s*["'`](--[a-z][a-z0-9-]*)/gi)) defined.add(m[1]!);
}

// Only the bare `var(--x)` form — a comma means a fallback is standing by.
const referenced = new Map<string, string[]>();
for (const path of files) {
  const src = strip(readFileSync(path, "utf8"));
  // a template literal builds the name at runtime (categoryColor's `var(--category-${key})`);
  // there is no static name to check, and shared/categories.ts already clamps the input
  for (const m of src.matchAll(/var\(\s*(--[a-z][a-z0-9-]*)\s*\)/gi)) {
    const name = m[1]!;
    referenced.set(name, [...(referenced.get(name) ?? []), path.slice(ROOT.length)]);
  }
}

describe("design tokens", () => {
  it("every bare var(--x) names a property something defines", () => {
    const orphans = [...referenced.entries()]
      .filter(([name]) => !defined.has(name))
      .map(([name, where]) => `${name} — referenced in ${[...new Set(where)].join(", ")}`);
    expect(orphans).toEqual([]);
  });
});
