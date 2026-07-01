import { defineEventHandler, setHeader } from "h3";
import { reportList, SLUG_RE } from "../../utils/discoveryRepo";
import { readJsonBody } from "../../utils/http";
import { sha256Hex } from "../../utils/tokens";
import {
  assertMaxBody,
  getClientIp,
  rateLimit,
  tallyDistinctReport,
  useKv,
} from "../../utils/rateLimit";

// The public-address shape is validated (against discoveryRepo's shared SLUG_RE)
// before the slug is used as a KV key, so junk never reaches the DB.
// A list is withheld only once this many DISTINCT reporters (by hashed IP) flag
// it within the window — so no single actor can suppress a list on their own.
const REPORT_THRESHOLD = 3;
const REPORT_WINDOW_MS = 14 * 24 * 60 * 60_000; // 14 days to accumulate

// "Report list" — flag a public list for review. A single report no longer hides
// a list: it takes REPORT_THRESHOLD distinct reporters (IP-deduped) before
// reportList() sets flagged=true. status stays 'active', so the owner's edit/share
// access is untouched, and an admin can reverse it via /api/admin/lists/restore.
// Answers generically regardless of state, so it reveals nothing about which
// slugs exist or how close one is to the threshold.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "report", 10, 60_000);
  assertMaxBody(event, 4_000);

  const body = await readJsonBody<{ slug?: string }>(event);
  const slug = (typeof body?.slug === "string" ? body.slug : "").trim().toLowerCase();
  if (SLUG_RE.test(slug)) {
    const reporterHash = sha256Hex(getClientIp(event) || "unknown");
    const { reached } = await tallyDistinctReport(
      useKv(),
      slug,
      reporterHash,
      REPORT_THRESHOLD,
      REPORT_WINDOW_MS,
    );
    if (reached) await reportList(slug);
  }
  return { ok: true };
});
