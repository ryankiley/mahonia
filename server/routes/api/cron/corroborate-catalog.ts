import { defineEventHandler, setHeader } from "h3";
import { corroborateCatalog } from "../../../utils/candidates";
import { requireCronAuth } from "../../../utils/cronAuth";
import { useDb } from "../../../utils/db";

// Nightly community-intake job (registered in vercel.json). Promotes typed list
// items corroborated by >= K distinct lists into community/unverified catalog rows.
// Auth: requireCronAuth — Bearer $CRON_SECRET (Vercel) or x-admin-token for a
// manual run; rate-limited, 404 otherwise.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await requireCronAuth(event);

  const db = await useDb();
  const result = await corroborateCatalog(db);
  console.log("[cron] corroborate-catalog", JSON.stringify(result));
  return { ok: true, ...result };
});
