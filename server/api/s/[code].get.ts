import { defineEventHandler, getRouterParam } from "h3";
import { getByShareCode } from "../../utils/listRepo";
import { rateLimit } from "../../utils/rateLimit";
import { notFound, setNoIndex, setReadEdgeCache } from "../../utils/http";

// Read-only view by short share code. Read capability only — there is no path
// from here to a write endpoint.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "public-read");
  const code = getRouterParam(event, "code") || "";
  const snapshot = await getByShareCode(code);
  if (!snapshot) throw notFound();
  // edge-cached like every read surface (and this one also feeds the /e/{code}
  // SSR head) — see setReadEdgeCache for the shared window
  setReadEdgeCache(event);
  return { snapshot };
});
