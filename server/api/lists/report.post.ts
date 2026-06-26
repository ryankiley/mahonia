import { defineEventHandler, setHeader } from "h3";
import { reportList } from "../../utils/discoveryRepo";
import { readJsonBody } from "../../utils/http";
import { assertMaxBody, rateLimit } from "../../utils/rateLimit";

// "Report list" — flag a public list for review. Sets flagged=true (withheld
// from discovery + the /l read view, pending review); status stays 'active', so
// the owner's edit/share access is untouched. Rate-limited to slow mass-reporting.
// Answers generically whether or not anything matched, so it reveals nothing
// about which slugs exist.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "report", 10, 60_000);
  assertMaxBody(event, 4_000);
  const body = await readJsonBody<{ slug?: string }>(event);
  await reportList(typeof body?.slug === "string" ? body.slug : "");
  return { ok: true };
});
