import { defineEventHandler, setHeader } from "h3";
import { normalizeSlug } from "../../../shared/discovery";
import { reportList } from "../../utils/discoveryRepo";
import { readJsonBodyCapped } from "../../utils/http";
import { sha256Hex } from "../../utils/tokens";
import {
  getClientIp,
  rateLimit,
  tallyDistinctReport,
  useKv,
} from "../../utils/rateLimit";

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
  await rateLimit(event, "report");
  const body = await readJsonBodyCapped<{ slug?: string }>(event, 4_000);
  // shared shape rule (shared/discovery) — validated before the slug is used as
  // a KV key, and so junk never reaches the DB
  const slug = normalizeSlug(body?.slug);
  if (slug) {
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
