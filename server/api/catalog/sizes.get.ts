import { defineEventHandler, setHeader } from "h3";
import { productVariants } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { rateLimit } from "../../utils/rateLimit";
import { queryString, setNoIndex } from "../../utils/http";
import { isCatalogId } from "../../../shared/ops";
import { sortSizes, type CatalogSize } from "../../../shared/catalogSizes";

// Every size of the product a catalog row belongs to: `?id=` is any one of them. What a
// linked row's size picker lists (shared/catalogSizes). One product per request, on the
// search's rate limit, so it opens no more of the catalog than a search for the product's
// name already does; asked for only when a person starts editing a linked row.
//
// Cached a little longer than the search: nothing on the device stores these, so a
// stale entry can't be written back over a corrected row (search.get.ts says why that
// keeps the search's window short). A correction still reaches the picker within a minute.
export default defineEventHandler(async (event) => {
  await rateLimit(event, "catalog-search");
  setNoIndex(event);
  setHeader(event, "Cache-Control", "public, max-age=10, s-maxage=60");

  const id = Number(queryString(event, "id", 12));
  if (!isCatalogId(id)) return { sizes: [] };
  const product = await productVariants(await useCatalogDb(), { id });
  const sizes: CatalogSize[] = sortSizes(product?.variants ?? []).map((v) => ({
    id: v.id,
    variant: v.variant,
    weightMg: v.weightMg,
    kcal: v.kcal,
  }));
  return { sizes };
});
