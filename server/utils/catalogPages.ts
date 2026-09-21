// The catalog product pages' data, read once per instance from the committed CSV
// that Nitro bundles as a server asset (nuxt.config: serverAssets "seed", pattern
// catalog.csv). No database on this path, by design: the pages are prerendered at
// build from this same file and the sitemap lists them from it, so a crawler
// walking every page costs the free tiers nothing (see the /catalog route rule).
// Memoized like the card fonts (ogFonts.ts): one read shared by concurrent first
// calls, a transient failure retried rather than cached. `useStorage` is a Nitro
// auto-import — the rateLimit.ts convention.

import { catalogPagesFromCsv, type CatalogPage } from "../../shared/catalogPages";
import { memoized } from "./memoize";

export const catalogPages = memoized(async (): Promise<ReadonlyMap<string, CatalogPage>> => {
  const raw = await useStorage("assets:seed").getItemRaw("catalog.csv");
  if (raw == null) throw new Error("catalog.csv missing from server assets");
  const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
  return new Map(catalogPagesFromCsv(text).map((p) => [p.slug, p]));
});
