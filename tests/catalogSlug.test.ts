import { describe, expect, it } from "vitest";
import { CATALOG_SLUG_SEGMENT, isProductSlug, productSlug, slugifyCatalog } from "../shared/catalogSlug";

describe("slugifyCatalog", () => {
  it("folds like search: diacritics, case, punctuation to hyphens", () => {
    expect(slugifyCatalog("Fjällräven")).toBe("fjallraven");
    expect(slugifyCatalog("Klättermusen")).toBe("klattermusen");
    expect(slugifyCatalog("Piñon Bivy")).toBe("pinon-bivy");
    expect(slugifyCatalog("Bure 2.0")).toBe("bure-2-0");
    expect(slugifyCatalog("  Copper Spur HV UL2 ")).toBe("copper-spur-hv-ul2");
  });

  it("drops apostrophes and degree signs instead of splitting on them", () => {
    expect(slugifyCatalog("Men's Crater Lake Hoody")).toBe("mens-crater-lake-hoody");
    expect(slugifyCatalog("Women’s Tempest")).toBe("womens-tempest");
    expect(slugifyCatalog("Flex 15°F Quilt")).toBe("flex-15f-quilt");
  });

  it("spells out a plus, so the seven +/plain pairs get distinct addresses", () => {
    const pairs: [string, string][] = [
      ["X-Mid Pro 2", "X-Mid Pro 2+"],
      ["X-Mid Pro 2 Groundsheet", "X-Mid Pro 2+ Groundsheet"],
      ["Lone Peak 9", "Lone Peak 9+"],
      ["Flux Collapsible Bottle", "Flux+ Collapsible Bottle"],
      ["PackFlask", "PackFlask+"],
      ["Seeker Water Bag", "Seeker+ Water Bag"],
    ];
    for (const [a, b] of pairs) expect(slugifyCatalog(a), a).not.toBe(slugifyCatalog(b));
    expect(slugifyCatalog("X-Mid Pro 2+")).toBe("x-mid-pro-2-plus");
    expect(slugifyCatalog("Flux+ Collapsible Bottle")).toBe("flux-plus-collapsible-bottle");
  });

  it("spells out a minus sign before a digit, and only there", () => {
    expect(slugifyCatalog("Bishop Pass Windstopper -15F")).toBe("bishop-pass-windstopper-minus-15f");
    expect(slugifyCatalog("Bishop Pass Windstopper 15F")).toBe("bishop-pass-windstopper-15f");
    // a hyphen between letters, or before a letter, stays a separator
    expect(slugifyCatalog("X-Mid 2")).toBe("x-mid-2");
    expect(slugifyCatalog("Therm-a-Rest")).toBe("therm-a-rest");
    expect(slugifyCatalog("NeoAir XLite NXT")).toBe("neoair-xlite-nxt");
  });

  it("is idempotent on its own output and empty on nothing foldable", () => {
    const s = slugifyCatalog("Mountain Hardwear Bishop Pass -15F");
    expect(slugifyCatalog(s)).toBe(s);
    expect(slugifyCatalog("山と道")).toBe("");
    expect(slugifyCatalog("")).toBe("");
  });
});

describe("productSlug / isProductSlug", () => {
  it("joins brand and product with a slash, blank brand and all", () => {
    expect(productSlug("Durston", "X-Mid 2")).toBe("durston/x-mid-2");
    expect(productSlug(null, "X-Mid 2")).toBe("/x-mid-2");
  });
  it("accepts exactly two well-formed segments", () => {
    expect(isProductSlug("durston/x-mid-2")).toBe(true);
    expect(isProductSlug("durston/x-mid-2+")).toBe(false);
    expect(isProductSlug("durston")).toBe(false);
    expect(isProductSlug("durston/x-mid-2/extra")).toBe(false);
    expect(isProductSlug("/x-mid-2")).toBe(false);
    expect(isProductSlug("Durston/x-mid-2")).toBe(false);
    expect(isProductSlug("durston/-x-mid")).toBe(false);
    expect(CATALOG_SLUG_SEGMENT.test("a--b")).toBe(false);
  });
});
