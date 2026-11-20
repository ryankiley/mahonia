import { defineEventHandler, getQuery } from "h3";
import { isProductSlug } from "../../../shared/catalogSlug";
import { catalogPages } from "../../utils/catalogPages";
import { notFound, setDailyEdgeCache, setNoIndex } from "../../utils/http";

// One catalog product page's data, by its address (`?slug=brand/product`), from the
// committed CSV — never the database. The page under /catalog calls this in-process
// while it is prerendered at build; in production the static HTML answers instead,
// and this only serves a client-side navigation or a stray request. Cached a day at
// the edge like the other same-for-everyone text; noindex because the page is the
// thing to index, not its JSON.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  const slug = String(getQuery(event).slug ?? "");
  if (!isProductSlug(slug)) throw notFound("No such product");
  const page = (await catalogPages()).get(slug);
  if (!page) throw notFound("No such product");
  setDailyEdgeCache(event);
  return { page };
});
