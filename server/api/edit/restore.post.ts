import { createError, defineEventHandler } from "h3";
import { restoreSnapshotByEditHash } from "../../utils/listRepo";
import { requireEditHash } from "../../utils/editAuth";
import { notFound, readJsonBodyCapped, setNoIndex } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

// Restore a list to one of its snapshots. Capability-gated (see editAuth); the
// current state is snapshotted first so a restore is itself undoable. 404 when the
// capability or the snapshot id doesn't resolve to this caller's list (no
// cross-list oracle).
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "restore");
  const hash = await requireEditHash(event);
  const body = await readJsonBodyCapped<{ snapshotId?: number }>(event, 4_000);
  const id = Number(body?.snapshotId);
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: "Bad snapshot id" });
  const snapshot = await restoreSnapshotByEditHash(hash, id);
  if (!snapshot) throw notFound();
  return { snapshot };
});
