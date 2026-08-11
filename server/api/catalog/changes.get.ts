import { defineEventHandler, getQuery, setHeader } from "h3";
import { recentChanges } from "../../utils/catalog";
import { useCatalogDb } from "../../utils/db";
import { rateLimit } from "../../utils/rateLimit";
import { setNoIndex } from "../../utils/http";

// Recent catalog weight changes (the transparency / patrol feed). Public, read-only.
export default defineEventHandler(async (event) => {
  // Per-IP throttle: this feed exposes item + before/after weights, so cap bulk
  // pulls. Before the cache headers so a 429 isn't cached. Tunable.
  await rateLimit(event, "catalog-changes");

  setNoIndex(event);
  setHeader(event, "Cache-Control", "public, max-age=30");
  const q = getQuery(event);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
  const db = await useCatalogDb();
  return { changes: await recentChanges(db, limit) };
});
