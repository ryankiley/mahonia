import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogPagesFromCsv, pageWeightRange } from "../shared/catalogPages";
import { displayQuote } from "../shared/catalogQuote";
import { isProductSlug } from "../shared/catalogSlug";
import { CATALOG_CSV } from "../scripts/paths";

const HEADER = "brand,name,common_name,variant,attributes,attributes_unpublished,category_hint,weight_mg,weight_source,source_url,quote,kcal";
const csv = (rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

describe("catalogPagesFromCsv", () => {
  it("groups a product's variants under one slug, in file order", () => {
    const pages = catalogPagesFromCsv(
      csv([
        'Therm-a-Rest,NeoAir XLite NXT,Sleeping pad,Regular,,,sleep,369000,manufacturer,https://x.test/xlite,"Regular … Weight 13 oz (0.37 kg)",',
        'Therm-a-Rest,NeoAir XLite NXT,Sleeping pad,Large,,,sleep,482000,manufacturer,https://x.test/xlite,"Large … Weight 1 lb 1 oz (0.48 kg)",',
        "Durston,X-Mid 2,Tent,,persons=2,,shelter,887000,manufacturer,https://x.test/xmid,Complete Tent: 31.3 oz / 890 g,",
      ]),
    );
    expect(pages.map((p) => p.slug)).toEqual(["therm-a-rest/neoair-xlite-nxt", "durston/x-mid-2"]);
    const pad = pages[0]!;
    expect(pad.brand).toBe("Therm-a-Rest");
    expect(pad.commonName).toBe("Sleeping pad");
    expect(pad.variants.map((v) => [v.variant, v.weightMg])).toEqual([
      ["Regular", 369_000],
      ["Large", 482_000],
    ]);
    expect(pad.variants[0]!.quote).toBe("Regular … Weight 13 oz (0.37 kg)");
    expect(pageWeightRange(pad)).toEqual({ minMg: 369_000, maxMg: 482_000 });
    expect(pages[1]!.variants[0]!.variant).toBeNull();
    expect(pageWeightRange(pages[1]!)).toEqual({ minMg: 887_000, maxMg: 887_000 });
  });

  it("skips a row a page could not cite, and an unknown source", () => {
    const pages = catalogPagesFromCsv(
      csv([
        "Acme,No Quote,Tent,,,,shelter,1000,manufacturer,https://x.test/a,,",
        "Acme,No URL,Tent,,,,shelter,1000,manufacturer,,said so,",
        "Acme,Odd Source,Tent,,,,shelter,1000,hearsay,https://x.test/c,said so,",
        "Acme,Fine,Tent,,,,shelter,1000,measured,https://x.test/d,said so,",
      ]),
    );
    expect(pages.map((p) => p.name)).toEqual(["Fine"]);
    expect(pages[0]!.variants[0]!.weightSource).toBe("measured");
  });

  it("returns nothing for a CSV without the page columns", () => {
    expect(catalogPagesFromCsv("brand,name\nAcme,Thing\n")).toEqual([]);
    expect(catalogPagesFromCsv("")).toEqual([]);
  });

  it("reads the real catalog: every product, one valid address each", () => {
    const pages = catalogPagesFromCsv(readFileSync(CATALOG_CSV, "utf8"));
    expect(pages.length).toBeGreaterThan(2000);
    expect(pages.every((p) => isProductSlug(p.slug) && p.variants.length > 0)).toBe(true);
    expect(new Set(pages.map((p) => p.slug)).size).toBe(pages.length);
  });
});

describe("displayQuote", () => {
  it("turns a spec table's bars into the app's separator and drops tags", () => {
    expect(displayQuote("M | 3.8 oz | 108 g")).toBe("M · 3.8 oz · 108 g");
    expect(displayQuote("Weight: 1.5oz | 43g")).toBe("Weight: 1.5oz · 43g");
    expect(displayQuote('<div class="specs-title">Weight:</div> <div class="specs-content">5.29 oz/ 150 g</div>')).toBe("Weight: 5.29 oz/ 150 g");
    expect(displayQuote("  Complete Tent:   31.3 oz / 890 g ")).toBe("Complete Tent: 31.3 oz / 890 g");
  });
  it("leaves a plain sentence alone", () => {
    expect(displayQuote("A 20° Regular/Regular 950FP weighs 18.35 Ounces")).toBe("A 20° Regular/Regular 950FP weighs 18.35 Ounces");
  });
});
