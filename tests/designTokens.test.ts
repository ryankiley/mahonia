import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// EVERY var(--x) RESOLVES TO SOMETHING THAT DEFINES --x.
//
// This exists because `margin-block-start: var(--space-8)` sat on the About page for an
// unknown length of time doing nothing at all. There is no --space-8 — the scale runs
// 1-7, then 9 — so the declaration was invalid at computed-value time, the margin
// resolved to 0, and the section rule sat hard against the paragraph above it. Nothing
// reported it. Sass doesn't resolve custom properties, the browser drops the declaration
// silently, and the page still renders, so a typo here is invisible to the build, to the
// type checker and to every other test in this suite. It was found by looking at it.
//
// The trap is the shape of the scale: 1-7 then 9 makes --space-8 the natural thing to
// write, and the next person will write it again.
//
// A reference WITH A FALLBACK is deliberate, not a typo — `var(--hov-ink, var(--ink))`
// is how the travelling plate takes a row's own hue when a row has set one and the
// neutral when it hasn't — so those are skipped. What's checked is the bare form, the
// one that has nowhere to go when it's wrong.
const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(scss|vue|ts)$/.test(name)) out.push(path);
  }
  return out;
}

const files = walk(`${ROOT}app`);

// Comments come out first. This codebase argues with itself in prose — a rule that
// removed a token routinely says which token it removed, and says it in the `var(--x)`
// form — so a scanner reading raw text would take the explanation for the offence and
// fail on the very comment recording the fix. `//` only counts outside a `://`, or every
// URL in a comment would swallow the rest of its line.
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// A custom property is DEFINED by a `--name:` declaration anywhere — :root, a scoped
// component rule, inside a media query — or by a component handing an element one at
// runtime. Both runtime forms count, and both are in use: style.setProperty (--vault-w,
// --drag-dy, --hov-ink) and a Vue :style binding, whose key is QUOTED — the elevation
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
  // a template literal builds the name at runtime (categoryColor's `var(--cat-${key})`);
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

  // The spacing scale is the one that bit, and the one whose gap invites the typo.
  it("the spacing scale has no holes a reference could fall into", () => {
    const scale = [...defined].filter((n) => /^--space-\d+$/.test(n)).sort();
    expect(scale.length).toBeGreaterThan(0);
    const used = [...referenced.keys()].filter((n) => /^--space-\d+$/.test(n));
    expect(used.filter((n) => !defined.has(n))).toEqual([]);
  });
});
