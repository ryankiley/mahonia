import { createError, defineEventHandler, setHeader } from "h3";
import { listSnapshotsByEditToken } from "../../utils/listRepo";
import { requireEditToken } from "../../utils/auth";
import { rateLimit } from "../../utils/rateLimit";

// List a list's recovery points (vandalism recovery for the shared-edit model).
// Edit-token-gated; 404 when the token doesn't resolve (no existence oracle).
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "snapshots");
  const token = requireEditToken(event);
  const snapshots = await listSnapshotsByEditToken(token);
  if (!snapshots) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { snapshots };
});
