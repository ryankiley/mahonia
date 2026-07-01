import { createError, defineEventHandler, setHeader } from "h3";
import { revertEdit } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { readJsonBody } from "../../utils/http";
import { requireAdmin } from "../../utils/auth";

// One-click revert of an applied catalog edit. Admin-only: gated on GEAR_ADMIN_TOKEN.
// 404 (not 403) when unconfigured or the token is wrong — no oracle that the route exists.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await requireAdmin(event, 8_000);

  const body = await readJsonBody<{ editId?: number }>(event);
  const editId = Number(body?.editId);
  if (!Number.isInteger(editId) || editId <= 0)
    throw createError({ statusCode: 400, statusMessage: "Bad request" });

  const db = await useCatalogDb();
  return revertEdit(db, editId);
});
