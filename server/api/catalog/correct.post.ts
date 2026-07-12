import { createError, defineEventHandler, setHeader } from "h3";
import { parseWeightInput } from "../../../shared/weights";
import { proposeCorrection } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { readJsonBodyCapped } from "../../utils/http";
import { consumeRateLimit, rateLimit, useKv } from "../../utils/rateLimit";

// Beyond the per-IP `catalog-correct` budget, cap edits to a SINGLE catalog row
// (shared across all IPs) so IP-rotated vandalism can't rewrite one item's weight
// repeatedly. Well above any legitimate correction rate for a niche gear catalog.
const ITEM_EDIT_LIMIT = 6;
const ITEM_EDIT_WINDOW_MS = 60 * 60_000; // 1 hour

// "Fix a weight for everyone" (wiki edit). Trust-tiered in proposeCorrection:
// uncited/community values apply instantly; verified values need a trusted
// citation to auto-apply, else they're recorded as `proposed`.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "catalog-correct");

  const body = await readJsonBodyCapped<{
    catalogItemId?: number;
    weight?: string;
    weightMg?: number;
    sourceUrl?: string;
    reason?: string;
  }>(event, 8_000);

  const catalogItemId = Number(body?.catalogItemId);
  if (!Number.isInteger(catalogItemId) || catalogItemId <= 0)
    throw createError({ statusCode: 400, statusMessage: "Bad request" });

  // per-item throttle (shared KV, IP-independent) — bounds flood-vandalism of one row
  const overItem = await consumeRateLimit(
    useKv(),
    `rl:catalog-item:${catalogItemId}`,
    ITEM_EDIT_LIMIT,
    ITEM_EDIT_WINDOW_MS,
    Date.now(),
  );
  if (overItem)
    throw createError({ statusCode: 429, statusMessage: "Too many edits for this item" });

  // accept either a parsed mg value or a human weight string ("540 g", "1.2 kg")
  let weightMg = typeof body?.weightMg === "number" ? body.weightMg : Number.NaN;
  if (!Number.isFinite(weightMg) && typeof body?.weight === "string") {
    weightMg = parseWeightInput(body.weight) ?? Number.NaN;
  }
  if (!Number.isFinite(weightMg) || weightMg <= 0)
    throw createError({ statusCode: 400, statusMessage: "Bad weight" });

  const sourceUrl =
    typeof body?.sourceUrl === "string" && body.sourceUrl.trim()
      ? body.sourceUrl.trim().slice(0, 2000)
      : undefined;
  const reason =
    typeof body?.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : undefined;

  const db = await useCatalogDb();
  return proposeCorrection(db, { catalogItemId, newWeightMg: weightMg, sourceUrl, reason });
});
