import { defineEventHandler, getQuery } from "h3";
import { recentChanges } from "../../utils/catalog";
import { requireAdmin } from "../../utils/auth";
import { useCatalogDb } from "../../utils/db";
import { setNoIndex } from "../../utils/http";

// Recent catalog weight changes, newest first: the patrol feed that finds an edit's id
// for /api/catalog/revert. Admin-only. It was public and backed a /changes page, which
// was retired (2026-11-09) as a thin, mostly stale page nothing linked to; reverting a
// bad fix still needs the ids, so the feed stayed behind the same door as revert.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await requireAdmin(event);
  const q = getQuery(event);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
  const db = await useCatalogDb();
  return { changes: await recentChanges(db, limit) };
});
