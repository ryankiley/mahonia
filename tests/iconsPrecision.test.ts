// config/icons.ts rounds every glyph's path coordinates at build time — in
// PRODUCTION builds only (`apply: "build"`), where no other test sees the result:
// tests/hugeicon.nuxt.test.ts compares two renderers on the same untransformed data
// and passes on any `d`, even a corrupted one. So this is the one check that reads
// the transform's output, and it reads it for the whole installed package: a
// package release that ships minified path syntax ("M2.999.5", "L2.5-0.004") is
// exactly where the regex would fuse two coordinates into one, and the build must
// refuse it rather than ship a different drawing.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roundIconSource } from "../config/icons";

const DIR = join(process.cwd(), "node_modules/@hugeicons/core-free-icons/dist/esm");
const PATH_NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;
const dValues = (code: string) => [...code.matchAll(/d:\s*"([^"]+)"/g)].map((m) => m[1]);

describe("hugeicons precision", () => {
  it("rounds the installed package to two decimals without changing a single token count", () => {
    const files = readdirSync(DIR).filter((f) => /Icon\.js$/.test(f));
    expect(files.length).toBeGreaterThan(1000);
    let paths = 0;
    let longer = 0;
    for (const f of files) {
      const code = readFileSync(join(DIR, f), "utf8");
      const out = roundIconSource(code, 2, f); // throws on a token-count change
      const before = dValues(code);
      const after = dValues(out);
      expect(after.length).toBe(before.length);
      for (let i = 0; i < before.length; i++) {
        paths++;
        // same tokens, each within 0.005 of the original
        const a = before[i].match(PATH_NUMBER) ?? [];
        const b = after[i].match(PATH_NUMBER) ?? [];
        expect(b.length).toBe(a.length);
        for (let j = 0; j < a.length; j++) {
          expect(Math.abs(parseFloat(a[j]) - parseFloat(b[j]))).toBeLessThanOrEqual(0.005 + 1e-9);
          if (/\.\d{3,}/.test(b[j])) longer++;
        }
      }
    }
    expect(paths).toBeGreaterThan(1000);
    expect(longer).toBe(0);
  });

  it("refuses path data whose tokens would merge", () => {
    // an integer-rounding value followed by a bare-decimal number: "3" + ".5" reads as 3.5
    expect(() => roundIconSource('d: "M2.999.5L1 2"', 2, "t")).toThrow(/merge path tokens/);
    // a negative that rounds to zero loses its sign, and with it the separator
    expect(() => roundIconSource('d: "L2.5-0.004 4"', 2, "t")).toThrow(/merge path tokens/);
    // the same values with separators are fine, and rounded
    expect(roundIconSource('d: "M2.999 .5L1 2"', 2, "t")).toBe('d: "M3 .5L1 2"');
    expect(roundIconSource('d: "L2.5 -0.004 4"', 2, "t")).toBe('d: "L2.5 0 4"');
  });

  it("leaves modules without path data untouched", () => {
    const barrel = readFileSync(join(DIR, "index.js"), "utf8");
    expect(roundIconSource(barrel)).toBe(barrel);
  });
});
