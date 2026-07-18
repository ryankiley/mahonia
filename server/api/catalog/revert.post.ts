import { createError, defineEventHandler, setHeader } from "h3";
import { requireAdmin } from "../../utils/auth";
import { revertEdit } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { readJsonBodyCapped } from "../../utils/http";

// One-click revert of an applied catalog edit. Admin-only: gated on GEAR_ADMIN_TOKEN
// via requireAdmin (rate-limited, constant-time, 404 on a miss — no route oracle).
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await requireAdmin(event);

  // capped on actual bytes received — a Content-Length check is client-supplied
  // and spoofable, so the raw-body cap is the authoritative one
  const body = await readJsonBodyCapped<{ editId?: number }>(event, 8_000);
  const editId = Number(body?.editId);
  if (!Number.isInteger(editId) || editId <= 0)
    throw createError({ statusCode: 400, statusMessage: "Bad request" });

  const db = await useCatalogDb();
  return revertEdit(db, editId);
});
