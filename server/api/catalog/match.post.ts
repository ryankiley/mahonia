import { createError, defineEventHandler } from "h3";
import { buildCatalogNameIndex, lookupImported, type ImportedName } from "../../../shared/catalogMatch";
import { MAX_BRAND_LEN, MAX_ITEMS, MAX_ITEM_NAME_LEN, MAX_VARIANT_LEN } from "../../../shared/ops";
import { activeCatalogRows } from "../../utils/catalog";
import { useDb } from "../../utils/db";
import { isObjectLike, readJsonBodyCapped, setNoIndex } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

// Which of these imported names are catalog products, word for word? One request per
// import carrying every row's name; the answer is positional, a result or null each.
// Exact matches only (shared/catalogMatch.ts). The endpoint answers names the caller
// already holds, so it opens no enumeration surface beyond search — and it's throttled
// like one, tighter, since a real import asks once.
export default defineEventHandler(async (event) => {
  await rateLimit(event, "catalog-match");
  setNoIndex(event);

  const body = await readJsonBodyCapped<{ names?: unknown }>(event, 64_000);
  const raw = Array.isArray(body?.names) ? (body.names as unknown[]) : null;
  if (!raw) throw createError({ statusCode: 400, statusMessage: "names[] required" });
  if (raw.length > MAX_ITEMS) throw createError({ statusCode: 413, statusMessage: `At most ${MAX_ITEMS} names` });

  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const names: ImportedName[] = raw.map((n) => {
    const o = (isObjectLike(n) ? n : {}) as Record<string, unknown>;
    return { name: str(o.name, MAX_ITEM_NAME_LEN) ?? "", brand: str(o.brand, MAX_BRAND_LEN), variant: str(o.variant, MAX_VARIANT_LEN) };
  });

  const index = buildCatalogNameIndex(await activeCatalogRows(await useDb()));
  return { matches: names.map((n) => lookupImported(index, n)) };
});
