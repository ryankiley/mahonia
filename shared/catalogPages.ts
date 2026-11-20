// What a catalog product page shows, read straight out of the committed CSV: the
// product's variants with each one's cited weight, provenance, source page and the
// page's own words. No database is involved anywhere on this path — the pages are
// prerendered at build and the sitemap lists them from the same file — which is
// what keeps 2,300 crawlable pages off the free tiers (see nuxt.config's /catalog
// rule). scripts/catalogCsv.ts is the seed pipeline's full parser (attributes,
// search terms); this one reads only the columns a page needs, by header name, so
// server code can use it without importing scripts/.

import { productSlug } from "./catalogSlug";
import { parseCsv } from "./exporters/csv";
import { WEIGHT_SOURCES, type WeightSource } from "./types";

export interface CatalogPageVariant {
  variant: string | null;
  weightMg: number;
  weightSource: WeightSource;
  sourceUrl: string;
  quote: string;
}

export interface CatalogPage {
  /** `<brand>/<product>`, the address under /catalog (shared/catalogSlug.ts) */
  slug: string;
  brand: string;
  name: string;
  commonName: string | null;
  categoryHint: string | null;
  /** in CSV order: the build sorts variants within a product */
  variants: CatalogPageVariant[];
}

/** Every product with a page, grouped from the CSV's rows in their order. A row
 *  the build would not have written (no quote, no URL, an unknown source) is
 *  skipped rather than thrown on: the pages are read-only over a file the build
 *  has already validated, and one odd row must not take every page down. */
export function catalogPagesFromCsv(text: string): CatalogPage[] {
  const grid = parseCsv(text);
  const header = (grid[0] ?? []).map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iBrand = col("brand");
  const iName = col("name");
  const iCommon = col("common_name");
  const iVariant = col("variant");
  const iCat = col("category_hint");
  const iMg = col("weight_mg");
  const iSrc = col("weight_source");
  const iUrl = col("source_url");
  const iQuote = col("quote");
  if (iName < 0 || iMg < 0 || iSrc < 0 || iUrl < 0 || iQuote < 0) return [];

  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
  const pages = new Map<string, CatalogPage>();
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const name = cell(cells, iName);
    if (!name) continue;
    const weightMg = Number(cell(cells, iMg));
    const weightSource = cell(cells, iSrc);
    const sourceUrl = cell(cells, iUrl);
    const quote = cell(cells, iQuote);
    if (!Number.isInteger(weightMg) || weightMg <= 0 || !sourceUrl || !quote) continue;
    if (!(WEIGHT_SOURCES as readonly string[]).includes(weightSource)) continue;
    const brand = cell(cells, iBrand);
    const slug = productSlug(brand, name);
    const page =
      pages.get(slug) ??
      pages
        .set(slug, {
          slug,
          brand,
          name,
          commonName: cell(cells, iCommon) || null,
          categoryHint: cell(cells, iCat) || null,
          variants: [],
        })
        .get(slug)!;
    page.variants.push({
      variant: cell(cells, iVariant) || null,
      weightMg,
      weightSource: weightSource as WeightSource,
      sourceUrl,
      quote,
    });
  }
  return [...pages.values()];
}

/** The lightest and heaviest variant, in milligrams. Equal for a single variant. */
export function pageWeightRange(page: CatalogPage): { minMg: number; maxMg: number } {
  let minMg = Infinity;
  let maxMg = 0;
  for (const v of page.variants) {
    if (v.weightMg < minMg) minMg = v.weightMg;
    if (v.weightMg > maxMg) maxMg = v.weightMg;
  }
  return { minMg, maxMg };
}
