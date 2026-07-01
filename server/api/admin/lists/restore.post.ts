import { createError, defineEventHandler, setHeader } from "h3";
import { restoreList, SLUG_RE } from "../../../utils/discoveryRepo";
import { readJsonBody } from "../../../utils/http";
import { clearReportTally, useKv } from "../../../utils/rateLimit";
import { requireAdmin } from "../../../utils/auth";

// Admin: restore a reported/flagged list to discovery (the counterpart to the
// public report endpoint). Gated on GEAR_ADMIN_TOKEN; 404 (not 403) when
// unconfigured or the token is wrong — no oracle that the route exists. Mirrors
// the catalog revert admin gate.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await requireAdmin(event, 4_000);

  const body = await readJsonBody<{ slug?: string }>(event);
  const slug = (typeof body?.slug === "string" ? body.slug : "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw createError({ statusCode: 400, statusMessage: "Bad request" });

  const restored = await restoreList(slug);
  // Reset the distinct-report tally so the restored list can't instantly re-flag
  // off the prior reporters.
  await clearReportTally(useKv(), slug);

  return { ok: true, restored };
});
