import { createError, defineEventHandler, setHeader } from "h3";
import { parseWeightInput } from "../../../shared/weights";
import { proposeCorrection } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { readJsonBody } from "../../utils/http";
import { assertMaxBody, rateLimit } from "../../utils/rateLimit";

// "Fix a weight for everyone" (wiki edit). Trust-tiered in proposeCorrection:
// uncited/community values apply instantly; verified values need a trusted
// citation to auto-apply, else they're recorded as `proposed`.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  assertMaxBody(event, 8_000);
  await rateLimit(event, "catalog-correct", 20, 60_000);

  const body = await readJsonBody<{
    catalogItemId?: number;
    weight?: string;
    weightMg?: number;
    sourceUrl?: string;
    reason?: string;
  }>(event);

  const catalogItemId = Number(body?.catalogItemId);
  if (!Number.isInteger(catalogItemId) || catalogItemId <= 0)
    throw createError({ statusCode: 400, statusMessage: "Bad request" });

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
