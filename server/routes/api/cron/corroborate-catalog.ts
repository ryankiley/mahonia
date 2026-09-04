import { defineEventHandler } from "h3";
import { corroborateCatalog } from "../../../utils/candidates";
import { requireAdmin } from "../../../utils/auth";
import { useDb } from "../../../utils/db";
import { setNoIndex } from "../../../utils/http";

// Nightly community-intake job (registered in vercel.json). Promotes typed list
// items corroborated by >= K distinct lists into community/unverified catalog rows.
// Auth: requireAdmin with the cron door — Bearer $CRON_SECRET (Vercel) or
// x-admin-token for a manual run; rate-limited, 404 otherwise.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await requireAdmin(event, { orBearer: process.env.CRON_SECRET });

  const db = await useDb();
  const result = await corroborateCatalog(db);
  console.log("[cron] corroborate-catalog", JSON.stringify(result));
  return { ok: true, ...result };
});
