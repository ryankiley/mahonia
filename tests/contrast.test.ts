import { describe, expect, it } from "vitest";
import { contrast, luminance, mix, readableShare, rgbOf, type Rgb } from "../shared/contrast";

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

describe("contrast", () => {
  it("reads a colour input's hex", () => {
    expect(rgbOf("#ff8000")).toEqual([255, 128, 0]);
  });

  it("measures WCAG's luminance and ratio", () => {
    expect(luminance(BLACK)).toBe(0);
    expect(luminance(WHITE)).toBeCloseTo(1, 10);
    expect(contrast(BLACK, WHITE)).toBeCloseTo(21, 10);
    expect(contrast(WHITE, BLACK)).toBeCloseTo(21, 10);
  });

  it("keeps the theme's share where it already reads", () => {
    // the dark theme's secondary grey, 65% white over black, is well past 4.5:1
    expect(readableShare(BLACK, WHITE, 0.65, BLACK, 4.5)).toBe(0.65);
  });

  it("takes more ink over a mid-tone, until it reads", () => {
    const teal = rgbOf("#2a7f7f");
    const s = readableShare(teal, WHITE, 0.65, teal, 4.5);
    expect(s).toBeGreaterThan(0.65);
    expect(contrast(mix(teal, WHITE, s), teal)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mix(teal, WHITE, s - 0.02), teal)).toBeLessThan(4.5);
  });

  it("goes all the way to the ink when nothing less reads", () => {
    const grey = rgbOf("#777777");
    expect(readableShare(grey, WHITE, 0.5, grey, 21)).toBe(1);
  });
});
