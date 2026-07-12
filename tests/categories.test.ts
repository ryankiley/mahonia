import { describe, expect, it } from "vitest";
import { categoryColor } from "../shared/categories";

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
