import { defineEventHandler, setHeader } from "h3";
import { catalogBrands } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { rateLimit } from "../../utils/rateLimit";
import { setNoIndex } from "../../utils/http";

// The catalog's makers, for My Gear's edit dialog to suggest under Brand. types.get.ts's
// twin: labels, not weights, so caching them cannot roll a corrected weight back.
export default defineEventHandler(async (event) => {
  await rateLimit(event, "catalog-search");
  setNoIndex(event);
  setHeader(event, "Cache-Control", "public, max-age=3600, s-maxage=86400");
  return catalogBrands(await useCatalogDb());
});
