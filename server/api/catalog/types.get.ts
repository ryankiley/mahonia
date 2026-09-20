import { defineEventHandler, setHeader } from "h3";
import { catalogGearTypes } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { rateLimit } from "../../utils/rateLimit";
import { setNoIndex } from "../../utils/http";

export default defineEventHandler(async (event) => {
  await rateLimit(event, "catalog-search");
  setNoIndex(event);
  // Labels, not weights: caching these cannot roll a corrected weight back.
  setHeader(event, "Cache-Control", "public, max-age=3600, s-maxage=86400");
  return catalogGearTypes(await useCatalogDb());
});
