import { createError, defineEventHandler, setHeader } from "h3";
import { restoreSnapshotByEditToken } from "../../utils/listRepo";
import { requireEditToken } from "../../utils/auth";
import { readJsonBody } from "../../utils/http";
import { assertMaxBody, rateLimit } from "../../utils/rateLimit";

// Restore a list to one of its snapshots. Edit-token-gated; the current state is
// snapshotted first so a restore is itself undoable. 404 when the token or the
// snapshot id doesn't resolve to this caller's list (no cross-list oracle).
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "restore");
  assertMaxBody(event, 4_000);
  const token = requireEditToken(event);
  const body = await readJsonBody<{ snapshotId?: number }>(event);
  const id = Number(body?.snapshotId);
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: "Bad snapshot id" });
  const snapshot = await restoreSnapshotByEditToken(token, id);
  if (!snapshot) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { snapshot };
});
