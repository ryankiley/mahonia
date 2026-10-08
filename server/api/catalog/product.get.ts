import { defineEventHandler, getQuery } from "h3";
import { isProductSlug } from "../../../shared/catalogSlug";
import { isCatalogId } from "../../../shared/ops";
import { productVariants } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { notFound, setNoIndex } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

// One catalog product with every active variant — what the editor needs to turn a
// catalog page's "Pack this" (/e?add=<slug>) into a linked row: the ids the page
// itself never had, since it was built from the CSV. By the page's slug, or by a
// row id (the MCP product tool's shape). The one database read on the catalog
// pages' path, and a person presses it, so it is rate-limited like a read, not
// cached: a stale id would link the row to a row that isn't there.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "catalog-product");
  const q = getQuery(event);
  const slug = typeof q.slug === "string" ? q.slug : "";
  const id = Number(q.id);
  const ref = slug ? { slug } : isCatalogId(id) ? { id } : null;
  if (!ref || (slug && !isProductSlug(slug))) throw notFound("No such product");
  const product = await productVariants(await useCatalogDb(), ref);
  if (!product) throw notFound("No such product");
  return { product };
});
