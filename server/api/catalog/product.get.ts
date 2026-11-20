import { defineEventHandler, getQuery } from "h3";
import { isProductSlug } from "../../../shared/catalogSlug";
import { productVariants } from "../../utils/catalog";
import { catalogPages } from "../../utils/catalogPages";
import { useCatalogDb } from "../../utils/db";
import { notFound, setNoIndex } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

// One catalog product with the variants its page shows — what the editor needs to
// turn a catalog page's "Pack this" (/e?add=<slug>) into a linked row: the ids the
// page itself never had, since it was built from the CSV. The slug is resolved
// through that same CSV, bundled with the server (utils/catalogPages), never a column
// the seeder has to have written first, so a page answers the moment it deploys;
// then the database gives the ids by brand and name. Only the rows ON the page come
// back: a community row someone typed under the same product (an unverified size) is
// not what the page offered, and with no variant named the first sibling could be it.
// The one database read on the catalog pages' path, and a person presses it, so it is
// rate-limited like a read, not cached: a stale id would link a row that isn't there.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "catalog-product");
  const slug = String(getQuery(event).slug ?? "");
  if (!isProductSlug(slug)) throw notFound("No such product");
  const page = (await catalogPages()).get(slug);
  if (!page) throw notFound("No such product");
  const product = await productVariants(await useCatalogDb(), { brand: page.brand || undefined, name: page.name });
  const onPage = new Set(page.variants.map((v) => v.variant ?? ""));
  const variants = product?.variants.filter((v) => onPage.has(v.variant ?? "")) ?? [];
  // the CSV knows it and the database doesn't (yet): a deploy that ran ahead of its reseed
  if (!product || !variants.length) throw notFound("No such product");
  return { product: { ...product, variants } };
});
