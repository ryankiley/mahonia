import { defineEventHandler, getRouterParam, setHeader } from "h3";
import { getByShareCode } from "../../utils/listRepo";
import { rateLimit } from "../../utils/rateLimit";
import { notFound, setNoIndex } from "../../utils/http";

// Read-only view by short share code. Read capability only — there is no path
// from here to a write endpoint.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "public-read");
  const code = getRouterParam(event, "code") || "";
  const snapshot = await getByShareCode(code);
  if (!snapshot) throw notFound();
  // edge-cache the read for a short window, mirroring /api/l — collapses the
  // burst when a share link makes the rounds (and feeds the /e/{code} SSR head).
  // 30 s of staleness on a read-only view is the same accepted trade as /l.
  setHeader(
    event,
    "Cache-Control",
    "public, max-age=0, s-maxage=30, stale-while-revalidate=120",
  );
  return { snapshot };
});
