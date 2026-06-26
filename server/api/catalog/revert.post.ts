import { createError, defineEventHandler, getHeader, setHeader } from "h3";
import { ensureCatalogSchema, revertEdit } from "../../utils/catalog";
import { useDb } from "../../utils/db";
import { readJsonBody } from "../../utils/http";
import { assertMaxBody } from "../../utils/rateLimit";

// One-click revert of an applied catalog edit. Admin-only: gated on GEAR_ADMIN_TOKEN.
// 404 (not 403) when unconfigured or the token is wrong — no oracle that the route exists.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  assertMaxBody(event, 8_000);
  const admin = process.env.GEAR_ADMIN_TOKEN;
  const provided = getHeader(event, "x-admin-token");
  if (!admin || provided !== admin) throw createError({ statusCode: 404, statusMessage: "Not found" });

  const body = await readJsonBody<{ editId?: number }>(event);
  const editId = Number(body?.editId);
  if (!Number.isInteger(editId) || editId <= 0)
    throw createError({ statusCode: 400, statusMessage: "Bad request" });

  const db = await useDb();
  await ensureCatalogSchema(db);
  return revertEdit(db, editId);
});
