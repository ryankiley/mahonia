// <SvgIcon> (app/utils/icon.ts) draws every glyph in the app, so its contract is pinned
// here: a named size step sets the glyph's box (attributes and a class the stylesheet sizes
// from the step's token, which must agree with ICON_SIZES), each step draws a flat stroke in
// screen px on the <svg> unless a call site says otherwise, a glyph part that carries its own
// width keeps it, and fall-through attrs land on the <svg>. And every glyph it can be handed,
// Central's and ours, is well-formed data: the tags it draws, path data on the 24-unit grid,
// and no stroke width except a deliberate hairline, so the step's stroke reaches every line.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { ICON_SIZES, SvgIcon, type IconNode } from "~/utils/icon";
import * as central from "~/icons/central";
import * as ours from "~/icons/mahonia";

const ALL: [string, IconNode][] = [...Object.entries(central), ...Object.entries(ours)] as [string, IconNode][];
const html = (props: Record<string, unknown>, attrs: Record<string, string> = {}) => mount(SvgIcon, { props: props as never, attrs }).html();
const svgOpen = (h: string) => h.slice(0, h.indexOf(">") + 1);

describe("SvgIcon", () => {
  it("draws md by default: 18px, a 1.5px line on the svg, none on the paths", () => {
    const out = html({ icon: central.IconTrashCan });
    expect(svgOpen(out)).toContain('width="18"');
    expect(svgOpen(out)).toContain('stroke-width="1.5"');
    expect(svgOpen(out)).toMatch(/class="svgicon svgicon--md"/);
    expect(out.slice(out.indexOf(">") + 1)).not.toContain("stroke-width");
  });

  it("sizes and strokes each named step from ICON_SIZES", () => {
    for (const [step, { px, stroke }] of Object.entries(ICON_SIZES)) {
      const open = svgOpen(html({ icon: central.IconTrashCan, size: step }));
      expect(open).toContain(`width="${px}"`);
      expect(open).toContain(`stroke-width="${stroke}"`);
      expect(open).toContain(`svgicon--${step}`);
    }
  });

  it("falls back to md for a size it doesn't know", () => {
    expect(svgOpen(html({ icon: central.IconTrashCan, size: "16" }))).toContain("svgicon--md");
  });

  it("takes a call site's stroke, in screen px", () => {
    expect(svgOpen(html({ icon: central.IconTrashCan, size: "sm", strokeWidth: 1 }))).toContain('stroke-width="1"');
  });

  it("holds each step's px to its token in tokens.scss", () => {
    const tokens = readFileSync("app/assets/styles/foundations/tokens.scss", "utf8");
    const token = (name: string) => Number(tokens.match(new RegExp(`--${name}:\\s*calc\\((\\d+) \\* var\\(--tpx\\)\\)`))?.[1]);
    for (const [step, { px }] of Object.entries(ICON_SIZES)) {
      expect(token(step === "md" ? "icon" : `icon-${step}`), `--icon${step === "md" ? "" : `-${step}`}`).toBe(px);
    }
  });

  it("leaves a part's own hairline alone", () => {
    const withHairline = ALL.find(([, icon]) => icon.some(([, a]) => a.strokeWidth !== undefined));
    expect(withHairline, "Central ships a few dots with their own thin stroke").toBeDefined();
    const [, icon] = withHairline!;
    const own = icon.find(([, a]) => a.strokeWidth !== undefined)![1].strokeWidth;
    expect(html({ icon })).toContain(`stroke-width="${own}"`);
  });

  it("kebab-cases attributes and drops key", () => {
    const out = html({ icon: [["path", { d: "M1 1H2", strokeLinecap: "round", key: "0" }]] as IconNode });
    expect(out).toContain('stroke-linecap="round"');
    expect(out).not.toContain("key=");
  });

  it("passes class and aria-hidden through to the svg, beside its own", () => {
    const out = svgOpen(html({ icon: central.IconFormSquare, size: "lg" }, { class: "item__boxicon is-on", "aria-hidden": "true" }));
    expect(out).toMatch(/class="svgicon svgicon--lg item__boxicon is-on"/);
    expect(out).toMatch(/aria-hidden="true"/);
  });

  it("draws altIcon only when showAlt is set", () => {
    const base = { icon: central.IconFormSquare, altIcon: ours.TentGlyph };
    expect(html({ ...base, showAlt: false })).toBe(html({ icon: central.IconFormSquare }));
    expect(html({ ...base, showAlt: true })).toBe(html({ icon: ours.TentGlyph }));
  });
});

describe("every glyph", () => {
  const TAGS = new Set(["path", "circle", "rect", "line", "ellipse", "polyline", "polygon"]);
  const NUM = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

  it("covers both sets", () => {
    expect(Object.keys(central).length).toBeGreaterThan(80);
    expect(Object.keys(ours).length).toBeGreaterThan(20);
  });

  for (const [name, icon] of ALL) {
    it(`${name} is drawable data on the 24 grid`, () => {
      expect(icon.length).toBeGreaterThan(0);
      for (const [tag, attrs] of icon) {
        expect(TAGS.has(tag), `${name}: <${tag}>`).toBe(true);
        if (tag === "path") expect(typeof attrs.d, `${name}: path without d`).toBe("string");
        // a width of its own only for a deliberate hairline, never the nominal 2 or 1.5
        if (attrs.strokeWidth !== undefined) expect(Number(attrs.strokeWidth), `${name}: own stroke width`).toBeLessThan(1);
        for (const n of String(attrs.d ?? "").match(NUM) ?? []) {
          expect(Math.abs(Number(n)), `${name}: ${n} off the grid`).toBeLessThanOrEqual(24);
        }
      }
    });
  }
});
