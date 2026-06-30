import { describe, expect, it } from "vitest";
import { itemSearchName, itemSearchUrl, webSearchUrl } from "../shared/links";

describe("webSearchUrl", () => {
  it("builds a Google search URL for a simple query", () => {
    expect(webSearchUrl("Nemo")).toBe("https://www.google.com/search?q=Nemo");
  });

  it("encodes spaces in a multi-word product name", () => {
    expect(webSearchUrl("Nemo Hornet Elite OSMO 2P")).toBe(
      "https://www.google.com/search?q=Nemo%20Hornet%20Elite%20OSMO%202P",
    );
  });

  it("encodes special characters", () => {
    // & / ? # + and unicode must all be percent-encoded so the query is literal
    expect(webSearchUrl("Sea to Summit Spark Sp III · 18°F & down")).toBe(
      "https://www.google.com/search?q=Sea%20to%20Summit%20Spark%20Sp%20III%20%C2%B7%2018%C2%B0F%20%26%20down",
    );
  });
});

describe("itemSearchName", () => {
  it("joins brand + model", () => {
    expect(itemSearchName({ brand: "Nemo", name: "Hornet Elite OSMO" })).toBe(
      "Nemo Hornet Elite OSMO",
    );
  });

  it("drops the variant (size/config noise) from the query", () => {
    // the variant must NOT appear — a search for "Regular, quilt + Fast Sheet" is
    // noise; "Zenbivy Ultralight Bed 25F" lands on the product (25F lives in name)
    const item = {
      brand: "Zenbivy",
      name: "Ultralight Bed 25F",
      variant: "Regular, quilt + Fast Sheet",
    };
    expect(itemSearchName(item)).toBe("Zenbivy Ultralight Bed 25F");
  });

  it("is just the name for a brandless (free-renamed) item", () => {
    expect(itemSearchName({ brand: "", name: "My custom tarp" })).toBe("My custom tarp");
    expect(itemSearchName({ brand: null, name: "My custom tarp" })).toBe("My custom tarp");
  });
});

describe("itemSearchUrl", () => {
  it("builds a brand+model search URL, variant excluded", () => {
    const item = { brand: "Nemo", name: "Hornet Elite OSMO", variant: "2P" };
    expect(itemSearchUrl(item)).toBe(
      "https://www.google.com/search?q=Nemo%20Hornet%20Elite%20OSMO",
    );
  });

  it("returns null for a water row (its amount is a volume, not a product)", () => {
    expect(itemSearchUrl({ brand: "", name: "Water" })).toBeNull();
    expect(itemSearchUrl({ brand: "", name: " water " })).toBeNull();
  });

  it("returns null for an unnamed row", () => {
    expect(itemSearchUrl({ brand: "", name: "" })).toBeNull();
    expect(itemSearchUrl({ brand: null, name: "   " })).toBeNull();
  });
});
