// A bare OptionMenu trigger's keyboard ring must not reach its neighbour.
//
// The trigger hugs its text (padding 0), and the row's unit sits one --space-1 (4px)
// from the weight it belongs to. The reset's ring is --focus-ring wide at
// --focus-offset, 2 + 2 = 4px out: its outer edge landed exactly on the figure. jsdom
// lays nothing out, so this reads the rule and the tokens and does the sum.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROOT, stripComments } from "./helpers/sources";

const sfc = stripComments(readFileSync(`${ROOT}app/components/OptionMenu.vue`, "utf8"));
const tokens = stripComments(readFileSync(`${ROOT}app/assets/styles/foundations/tokens.scss`, "utf8"));

const px = (token: string) => {
  const m = tokens.match(new RegExp(`${token}:\\s*(?:calc\\((\\d+) \\* var\\(--px\\)\\)|(\\d+)px)`));
  expect(m, `no px value for ${token}`).not.toBeNull();
  return Number(m![1] ?? m![2]);
};

describe("a bare option-menu trigger's focus ring", () => {
  const rule = sfc.match(/\.optmenu__btn:where\(:not\(\.btn\):focus-visible\)\s*\{([^}]*)\}/)?.[1] ?? "";

  it("is drawn on keyboard focus only, at no added weight, and not on a .btn trigger", () => {
    expect(rule).not.toBe("");
  });

  it("has a corner", () => {
    expect(rule).toMatch(/border-radius:\s*var\(--radius-1\)/);
  });

  it("stops short of a neighbour one --space-1 away", () => {
    expect(rule).toMatch(/outline-offset:\s*calc\(var\(--focus-offset\) \/ 2\)/);
    const reach = px("--focus-offset") / 2 + px("--focus-ring");
    expect(reach).toBeLessThan(px("--space-1"));
  });

  it("keeps the app's ring: no width, style or ink of its own", () => {
    expect(rule).not.toMatch(/outline(?:-width|-style|-color)?:/);
  });
});
