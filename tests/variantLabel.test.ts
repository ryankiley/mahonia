// A variant as a person reads it (shared/variantLabel): the catalog's letter sizes
// spelled out wherever a variant is shown, everything else as written.
import { describe, expect, it } from "vitest";
import { displayVariant } from "../shared/variantLabel";

describe("displayVariant", () => {
  it("spells a letter size out", () => {
    expect(displayVariant("M")).toBe("Medium");
    expect(displayVariant("Men's M")).toBe("Men's Medium");
    expect(displayVariant("Women's XS")).toBe("Women's X-Small");
    expect(displayVariant("M, JP 3")).toBe("Medium, JP 3");
    expect(displayVariant("XL")).toBe("X-Large");
  });
  it("leaves a range, a maker's own scale and everything that is not a letter size", () => {
    expect(displayVariant("S/M")).toBe("S/M");
    expect(displayVariant("2XL")).toBe("2XL");
    expect(displayVariant("US 9")).toBe("US 9");
    expect(displayVariant("Long")).toBe("Long");
    expect(displayVariant("Silpoly")).toBe("Silpoly");
    expect(displayVariant("20F, 600 g")).toBe("20F, 600 g");
    expect(displayVariant("Men's")).toBe("Men's");
    expect(displayVariant("")).toBe("");
    expect(displayVariant(null)).toBe("");
  });
});
