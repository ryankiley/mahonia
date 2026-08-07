import { describe, expect, it } from "vitest";
import { categoryColor, dayColorSequence } from "../shared/categories";

// categoryColor interpolates a folder's colorKey into a CSS value on the public
// read/share views, so an unsafe key must never reach the output verbatim.
describe("categoryColor", () => {
  it("resolves curated + procedural hue keys", () => {
    expect(categoryColor("shelter")).toBe("var(--cat-shelter, var(--cat-other))");
    expect(categoryColor("h240")).toContain("oklch");
  });

  it("falls back to the neutral token for unsafe keys — no CSS-value injection", () => {
    expect(categoryColor("x,url(//evil.tld)")).toBe("var(--cat-other)");
    expect(categoryColor("a;b")).toBe("var(--cat-other)");
    expect(categoryColor("")).toBe("var(--cat-other)");
  });
});

describe("dayColorSequence", () => {
  it("never gives a day the map's own colour", () => {
    // The days are drawn on a topographic basemap, and that map is mostly forest — in
    // green. Day 1 used to open on volt green, i.e. the one hue its background already
    // owns, which no amount of white casing under the line can rescue.
    const seq = dayColorSequence(9);
    expect(seq.some((c) => c.includes("cat-shelter"))).toBe(false);
  });

  it("gives every day of a long trip its own colour", () => {
    const seq = dayColorSequence(9);
    expect(new Set(seq).size).toBe(seq.length);
  });

  it("opens on pink, blue, orange — spaced, because adjacent days are compared", () => {
    // Order is load-bearing: two days that touch on the chart and on the map must not be
    // two shades of the same idea. This is nextFolderColor's max-gap rule, inherited
    // rather than restated.
    expect(dayColorSequence(3)).toEqual([
      "var(--cat-sleep, var(--cat-other))",
      "var(--cat-water, var(--cat-other))",
      "var(--cat-pack, var(--cat-other))",
    ]);
  });

  it("is the SAME sequence for any trip length — day 2 is day 2", () => {
    // The elevation profile and the route map both call this, and a four-day trip's day 2
    // must be the colour a two-day trip's day 2 is, or re-cutting an itinerary silently
    // repaints every mark on the page.
    expect(dayColorSequence(7).slice(0, 3)).toEqual(dayColorSequence(3));
  });

  it("handles the empty and negative cases without throwing", () => {
    expect(dayColorSequence(0)).toEqual([]);
    expect(dayColorSequence(-2)).toEqual([]);
  });
});
