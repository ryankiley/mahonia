import { createError, defineEventHandler, setHeader } from "h3";
import { normalizeSlug } from "../../../../shared/discovery";
import { requireAdmin } from "../../../utils/auth";
import { restoreList } from "../../../utils/discoveryRepo";
import { readJsonBodyCapped } from "../../../utils/http";
import { clearReportTally, useKv } from "../../../utils/rateLimit";

// Admin: restore a reported/flagged list to discovery (the counterpart to the
// public report endpoint). Gated on GEAR_ADMIN_TOKEN via requireAdmin
// (rate-limited, constant-time, 404 on a miss — no route oracle).
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await requireAdmin(event);

  // capped on actual bytes received — a Content-Length check is client-supplied
  // and spoofable, so the raw-body cap is the authoritative one
  const body = await readJsonBodyCapped<{ slug?: string }>(event, 4_000);
  const slug = normalizeSlug(body?.slug);
  if (!slug) throw createError({ statusCode: 400, statusMessage: "Bad request" });

  const restored = await restoreList(slug);
  // Reset the distinct-report tally so the restored list can't instantly re-flag
  // off the prior reporters.
  await clearReportTally(useKv(), slug);

  return { ok: true, restored };
});
